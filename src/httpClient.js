'use strict';

/**
 * HTTP layer with a pending-request registry.
 *
 * The critical behaviour this exists to model:
 *   A client giving up on a request is NOT the same as the request being
 *   cancelled. A real user who closes a slow checkout tab does not stop the
 *   server from completing the write. Phase 1 aborted the request when the
 *   client's patience expired, which destroyed the exact scenario the
 *   duplicate-write detector is supposed to observe.
 *
 * So: dispatch() starts the request and returns a handle immediately. The
 * request continues in the background under a separate hard ceiling that
 * exists only to prevent socket leaks. awaitSettled() races the caller's
 * patience against completion. When patience loses, the handle stays live
 * and settles later, producing a "late response" the analyst can use as
 * ground truth about what the server actually did.
 *
 * Uses the Node 18+ global fetch — no node-fetch dependency.
 */

const HARD_CEILING_MS = 30000;

class RequestHandle {
  constructor(id, descriptor) {
    this.id = id;
    this.descriptor = descriptor; // { method, path, url, idempotencyKey, attempt }
    this.startedAt = Date.now();
    this.settled = false;
    this.result = null;
    this.observedByClient = false; // did the actor still care when it settled?
    this._listeners = [];
    this.promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  _settle(result) {
    if (this.settled) return;
    this.settled = true;
    this.result = result;
    this._resolve(result);
    for (const fn of this._listeners) {
      try {
        fn(result, this);
      } catch (_) {
        /* listener errors must not break the run */
      }
    }
    this._listeners = [];
  }

  /** Fires only if the handle settles AFTER the client stopped waiting. */
  onLateSettle(fn) {
    if (this.settled) {
      if (!this.observedByClient) fn(this.result, this);
      return;
    }
    this._listeners.push((result, handle) => {
      if (!handle.observedByClient) fn(result, handle);
    });
  }
}

class RequestRegistry {
  constructor({ hardCeilingMs = HARD_CEILING_MS } = {}) {
    this.hardCeilingMs = hardCeilingMs;
    this.pending = new Set();
    this.duplicatesSent = 0;
    this.defaultHeaders = null; // e.g. a simulated-clock header per epoch
  }

  /**
   * Start a request. Returns a handle synchronously; the request runs on.
   */
  dispatch(baseUrl, method, path, { body, headers, idempotencyKey, attempt = 1, fault = null } = {}) {
    const url = `${baseUrl}${path}`;
    const handle = new RequestHandle(`${method} ${path} #${attempt}`, {
      method,
      path,
      url,
      idempotencyKey,
      attempt
    });

    this.pending.add(handle);

    const controller = new AbortController();
    const ceiling = setTimeout(() => controller.abort(), this.hardCeilingMs);
    const start = Date.now();

    const requestHeaders = {
      'Content-Type': 'application/json',
      ...(this.defaultHeaders || {}),
      ...(headers || {})
    };
    if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;

    handle.fault = fault;

    // A `reset` fault aborts the connection shortly after the request goes
    // out — deliberately AFTER it is sent, so the server may well have
    // processed it. A reset that prevented the request from leaving would be
    // uninteresting; the damage comes from writes that land on a connection
    // the client no longer has.
    if (fault && fault.type === 'reset') {
      const resetAfter = 40 + (attempt % 3) * 30;
      setTimeout(() => controller.abort(), resetAfter);
    }

    const send = () =>
      fetch(url, {
      method,
      headers: requestHeaders,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const startRequest = () => {
      send()
      .then(async (res) => {
        clearTimeout(ceiling);
        let parsed = null;
        try {
          parsed = await res.json();
        } catch (_) {
          parsed = null; // non-JSON body is acceptable
        }
        handle._settle({
          status: res.status,
          ok: res.status < 400,
          timedOut: false,
          abandoned: false,
          body: parsed,
          latencyMs: Date.now() - start,
          error: null
        });
      })
      .catch((err) => {
        clearTimeout(ceiling);
        const wasReset = fault && fault.type === 'reset' && err.name === 'AbortError';
        handle._settle({
          status: null,
          ok: false,
          timedOut: false,
          abandoned: err.name === 'AbortError' && !wasReset,
          reset: Boolean(wasReset),
          body: null,
          latencyMs: Date.now() - start,
          error: wasReset ? 'connection reset by chaos injection' : err.message
        });
      })
      .finally(() => {
        this.pending.delete(handle);
      });
    };

    // A `duplicate` fault sends the request twice, modelling a retrying
    // proxy. The client never learns a second one happened — which is the
    // point: this produces duplicate writes with no client retry involved.
    if (fault && fault.type === 'duplicate') {
      this.duplicatesSent++;
      fetch(url, {
        method,
        headers: requestHeaders,
        body: body != null ? JSON.stringify(body) : undefined
      }).catch(() => {});
    }

    if (fault && fault.type === 'delay') {
      setTimeout(startRequest, fault.delayMs || 0);
    } else {
      startRequest();
    }

    return handle;
  }

  /**
   * Wait up to patienceMs for a handle to settle.
   * Returns { resolved: true, result } if it settled in time, or
   * { resolved: false } if the client's patience ran out first — in which
   * case the request is still in flight and will settle later.
   */
  async awaitSettled(handle, patienceMs) {
    if (handle.settled) {
      handle.observedByClient = true;
      return { resolved: true, result: handle.result };
    }

    let timer;
    const patience = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__patience__'), patienceMs);
    });

    const winner = await Promise.race([handle.promise, patience]);
    clearTimeout(timer);

    if (winner === '__patience__' && !handle.settled) {
      return { resolved: false };
    }
    handle.observedByClient = true;
    return { resolved: true, result: handle.result };
  }

  /** Wait for every in-flight request to finish (bounded). */
  async drain(maxWaitMs = HARD_CEILING_MS + 2000) {
    const deadline = Date.now() + maxWaitMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.pending].map((h) => h.promise)),
        new Promise((r) => setTimeout(r, 250))
      ]);
    }
    return this.pending.size;
  }
}

module.exports = { RequestRegistry, RequestHandle, HARD_CEILING_MS };
