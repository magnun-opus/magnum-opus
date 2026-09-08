'use strict';

const { resolveTransition } = require('./conditionEvaluator');
const { interpolate } = require('../interpolate');
const { applyExtract, applySet } = require('./state');
const trpc = require('../protocols/trpc');

const MAX_STEPS = 50; // safety valve against malformed persona definitions

/**
 * Runs one actor through a persona definition to a terminal state.
 *
 * Changes from Phase 1:
 *  - `context` is created ONCE and persists across states. Previously it was
 *    re-created inside the loop, so lastResponse died at every state
 *    boundary and any condition evaluated after a wait read undefined.
 *  - Requests carry bodies, headers and interpolated paths, so each actor
 *    has its own identity instead of all actors sharing one session.
 *  - States may declare an `intent`, which derives a stable idempotency key
 *    shared by the original attempt and its retries. That key is how the
 *    analyst groups attempts, replacing the old tag-sniffing heuristic.
 *  - Client patience no longer cancels the request. When patience expires
 *    the handle stays live and a late_response event is logged when it
 *    settles, giving the analyst ground truth about the server's behaviour.
 */
async function runPersona(persona, { baseUrl, logger, registry, rng, actor, chaos = null }) {
  const context = {
    lastResponse: null,
    lastClientOutcome: null,
    responseArrivedDuringWait: null,
    vars: {},
    actor,
    pending: []
  };

  // Draw persona-level variables from the actor's own stream, so the same
  // seed always produces the same actor making the same choices.
  for (const [name, spec] of Object.entries(persona.variables || {})) {
    if (Array.isArray(spec.choice)) context.vars[name] = rng.pick(spec.choice);
    else if (spec.range) context.vars[name] = rng.int(spec.range[0], spec.range[1]);
    else context.vars[name] = spec.value;
  }

  // Authenticate once per actor, before the journey begins. Nearly every
  // real application starts behind a login, and without this a persona
  // cannot get past the front door.
  if (persona.auth) {
    const authed = await authenticate(persona, { context, logger, registry, baseUrl, rng });
    if (!authed) {
      logger.log({
        eventType: 'decision',
        action: 'terminal:auth_failed',
        outcome: 'abandon',
        payload: { reason: 'authentication failed' }
      });
      return { finalState: 'auth_failed', outcomeClass: 'abandon', context, intentAttempts: new Map() };
    }
  }

  const attemptsByIntent = new Map();
  let currentStateName = persona.states[0].name;
  let lastEventId = null;
  let steps = 0;

  while (steps++ < MAX_STEPS) {
    const state = persona.states.find((s) => s.name === currentStateName);
    if (!state) throw new Error(`Unknown state: ${currentStateName}`);

    if (state.on_enter) {
      const spec = state.on_enter;

      if (spec.event_type === 'http_request' || trpc.isTrpcSpec(persona, spec)) {
        lastEventId = await performRequest({
          spec,
          persona,
          context,
          logger,
          registry,
          baseUrl,
          attemptsByIntent,
          chaos,
          rng,
          parentEventId: lastEventId
        });
      } else if (spec.event_type === 'wait') {
        lastEventId = await performWait({
          spec,
          context,
          logger,
          registry,
          rng,
          parentEventId: lastEventId
        });
      }
    }

    // State-local mutations: budgets, counters, flags. Applied after the
    // request so it can reference anything just extracted, and before
    // transitions so a counter can bound a loop.
    if (state.set) applySet(state.set, context);

    // Optional think time — real users pause between actions.
    if (state.think_ms) {
      const [min, max] = Array.isArray(state.think_ms)
        ? state.think_ms
        : [state.think_ms, state.think_ms];
      await sleep(rng.range(min, max));
    }

    if (state.terminal) {
      const outcomeClass = state.outcome_class || 'neutral';
      logger.log({
        eventType: 'decision',
        action: `terminal:${state.name}`,
        outcome: outcomeClass,
        payload: { state: state.name },
        parentEventId: lastEventId
      });
      return { finalState: state.name, outcomeClass, context, intentAttempts: attemptsByIntent };
    }

    const transition = resolveTransition(state.transitions, context, () => rng.float());
    if (!transition) {
      logger.log({
        eventType: 'decision',
        action: `stalled_at:${state.name}`,
        outcome: 'stalled',
        parentEventId: lastEventId
      });
      return { finalState: state.name, outcomeClass: 'stalled', stalled: true, context, intentAttempts: attemptsByIntent };
    }

    currentStateName = transition.to;
  }

  throw new Error(`Persona exceeded MAX_STEPS (${MAX_STEPS}) — check for a transition loop.`);
}

async function performRequest({
  spec,
  persona,
  context,
  logger,
  registry,
  baseUrl,
  attemptsByIntent,
  chaos,
  rng,
  parentEventId
}) {
  const scope = { vars: context.vars, actor: context.actor };

  // A tRPC spec is translated into an ordinary request here; everything
  // downstream — dispatch, patience, retries, logging — is unchanged.
  const isTrpc = trpc.isTrpcSpec(persona, spec);
  let action;
  let method;
  let path;
  let body;

  if (isTrpc) {
    const built = trpc.buildRequest(persona, spec, scope);
    action = built.action;
    method = built.method;
    path = built.path;
    body = built.body;
  } else {
    action = interpolate(spec.action, scope);
    [method, path] = action.split(' ');
    body = spec.body ? interpolate(spec.body, scope) : undefined;
  }
  const headers = {
    ...(context.authHeaders || {}),
    ...(spec.headers ? interpolate(spec.headers, scope) : {})
  };

  // One idempotency key per logical intent, reused across retries. This is
  // what lets the analyst say "these two requests were the same intent"
  // instead of guessing from a 'retry' tag.
  let idempotencyKey;
  let attempt = 1;
  if (spec.intent) {
    idempotencyKey = `${context.actor.traceId}:${spec.intent}`;
    attempt = (attemptsByIntent.get(spec.intent) || 0) + 1;
    attemptsByIntent.set(spec.intent, attempt);
  }

  const patienceMs = spec.patience_ms || persona.patience_ms || 3000;

  // Chaos is drawn from the actor's own seeded stream, so a chaos run is
  // exactly as reproducible as a clean one.
  const fault = chaos ? chaos.select(method, rng) : null;

  const handle = registry.dispatch(baseUrl, method, path, {
    body,
    headers,
    idempotencyKey: persona.send_idempotency_key === false ? undefined : idempotencyKey,
    attempt,
    fault
  });

  const settled = await registry.awaitSettled(handle, patienceMs);

  if (settled.resolved) {
    const r = settled.result;
    const outcome = r.abandoned ? 'abandoned' : r.ok ? 'success' : 'error';
    context.lastResponse = r;
    context.lastClientOutcome = outcome === 'abandoned' ? 'timeout' : outcome;

    // Unwrapped BEFORE extraction and logging, so personas and detectors
    // never see the JSON-RPC envelope.
    const responseBody = isTrpc ? trpc.unwrapFor(persona, r.body) : r.body;
    applyExtract(spec.extract, responseBody, context, rng);

    return logger.log({
      eventType: 'http_request',
      action,
      outcome,
      latencyMs: r.latencyMs,
      httpStatus: r.status,
      idempotencyKey,
      attempt,
      payload: { request: body ?? null, response: responseBody, error: r.error, fault },
      tags: fault ? [...(spec.tags || []), `chaos:${fault.type}`] : spec.tags || [],
      parentEventId
    });
  }

  // Patience expired. The client gives up; the request keeps running.
  context.lastResponse = null;
  context.lastClientOutcome = 'timeout';
  context.pending.push(handle);

  const timeoutEventId = logger.log({
    eventType: 'http_request',
    action,
    outcome: 'timeout',
    latencyMs: patienceMs,
    httpStatus: null,
    idempotencyKey,
    attempt,
    payload: { request: body ?? null, response: null, error: 'client patience exceeded', fault },
    tags: [
      ...(spec.tags || []),
      'client_abandoned',
      ...(fault ? [`chaos:${fault.type}`] : [])
    ],
    parentEventId
  });

  // When the server eventually answers, record what it actually did. This is
  // the evidence the duplicate-write oracle needs.
  handle.onLateSettle((result) => {
    logger.log({
      eventType: 'late_response',
      action,
      outcome: result.abandoned ? 'abandoned' : result.ok ? 'success' : 'error',
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      idempotencyKey,
      attempt,
      payload: {
        request: body ?? null,
        response: isTrpc ? trpc.unwrapFor(persona, result.body) : result.body,
        error: result.error
      },
      tags: ['late_response'],
      parentEventId: timeoutEventId
    });
  });

  return timeoutEventId;
}

/**
 * A wait state races the actor's remaining patience against any request it
 * previously gave up on. In Phase 1 responseArrivedDuringWait was hardcoded
 * to false, making the "response finally arrived" branch unreachable.
 */
async function performWait({ spec, context, logger, registry, rng, parentEventId }) {
  const duration = spec.duration_ms || 500;
  const handle = context.pending[context.pending.length - 1];
  const start = Date.now();

  let arrived = false;
  if (handle && !handle.settled) {
    const settled = await registry.awaitSettled(handle, duration);
    arrived = settled.resolved;
    if (arrived) {
      context.lastResponse = settled.result;
      context.lastClientOutcome = settled.result.ok ? 'success' : 'error';
      context.pending.pop();
      applyExtract(spec.extract, settled.result.body, context, rng);
    }
  } else if (handle && handle.settled && !handle.observedByClient) {
    handle.observedByClient = true;
    arrived = true;
    context.lastResponse = handle.result;
    context.lastClientOutcome = handle.result.ok ? 'success' : 'error';
    context.pending.pop();
  } else {
    await sleep(duration);
  }

  context.responseArrivedDuringWait = arrived;

  return logger.log({
    eventType: 'wait',
    action: `wait_${duration}ms`,
    outcome: arrived ? 'response_arrived' : 'no_response',
    latencyMs: Date.now() - start,
    payload: { waitedMs: Date.now() - start, responseArrived: arrived },
    parentEventId
  });
}

/**
 * Run the persona's auth step and store the resulting header.
 *
 *   "auth": {
 *     "action": "POST /api/auth/login",
 *     "body":   { "email": "{{actor.sessionId}}@example.test", "password": "correct-horse" },
 *     "extract": { "token": "token" },
 *     "header": "Authorization",
 *     "format": "Bearer {{vars.token}}"
 *   }
 *
 * Logged as its own event so a failure at login is visible as a login
 * failure, rather than surfacing later as every endpoint returning 401.
 */
async function authenticate(persona, { context, logger, registry, baseUrl, rng }) {
  const spec = persona.auth;
  const scope = { vars: context.vars, actor: context.actor };

  // A tRPC spec is translated into an ordinary request here; everything
  // downstream — dispatch, patience, retries, logging — is unchanged.
  const isTrpc = trpc.isTrpcSpec(persona, spec);
  let action;
  let method;
  let path;
  let body;

  if (isTrpc) {
    const built = trpc.buildRequest(persona, spec, scope);
    action = built.action;
    method = built.method;
    path = built.path;
    body = built.body;
  } else {
    action = interpolate(spec.action, scope);
    [method, path] = action.split(' ');
    body = spec.body ? interpolate(spec.body, scope) : undefined;
  }

  const handle = registry.dispatch(baseUrl, method, path, {
    body,
    headers: spec.headers ? interpolate(spec.headers, scope) : undefined
  });
  const settled = await registry.awaitSettled(handle, spec.patience_ms || 5000);

  const ok = settled.resolved && settled.result.ok;
  if (ok) applyExtract(spec.extract, settled.result.body, context, rng);

  logger.log({
    eventType: 'auth',
    action,
    outcome: ok ? 'success' : settled.resolved ? 'error' : 'timeout',
    latencyMs: settled.resolved ? settled.result.latencyMs : null,
    httpStatus: settled.resolved ? settled.result.status : null,
    payload: { request: redactCredentials(body), authenticated: ok },
    tags: ['auth']
  });

  if (!ok) return false;

  const header = spec.header || 'Authorization';
  const value = interpolate(spec.format || '{{vars.token}}', {
    vars: context.vars,
    actor: context.actor
  });
  context.authHeaders = { [header]: value };
  return true;
}

/** Credentials must never reach the event log. */
function redactCredentials(body) {
  if (!body || typeof body !== 'object') return body;
  const safe = {};
  for (const [k, v] of Object.entries(body)) {
    safe[k] = /pass|secret|pin|token|otp|key/i.test(k) ? '****' : v;
  }
  return safe;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { runPersona };
