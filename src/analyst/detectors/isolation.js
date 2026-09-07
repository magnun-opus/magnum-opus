'use strict';

const crypto = require('crypto');
const { query } = require('../../db/client');

/**
 * Cross-actor isolation.
 *
 * Every actor has a unique synthetic_user_id, and the event log already
 * stores every response body. So a leak is directly observable: if actor A
 * received a response containing actor B's identifier, the application
 * served A data belonging to B.
 *
 *   for each event e owned by actor a:
 *     let S = { identifier(x) : x is an actor, x != a }
 *     violation iff any s in S occurs in the response body of e
 *
 * Matching is on the raw JSON text. Identifiers are long and structured
 * (sim-<seed>-<index>), so incidental collisions are implausible — but the
 * index suffix means "sim-s-1" is a substring of "sim-s-12", so matches are
 * checked against delimiter boundaries.
 *
 * This is a more serious class of finding than a duplicate write: a
 * duplicate costs a refund, a leak is a breach.
 */
async function detectIsolation(runId, options = {}) {
  if (options.enabled === false) return [];

  const { rows: actors } = await query(
    `SELECT actor_id, synthetic_user_id, persona_type FROM actors WHERE run_id = $1`,
    [runId]
  );
  if (actors.length < 2) return []; // nothing to leak between

  const idByActor = new Map(actors.map((a) => [a.actor_id, a.synthetic_user_id]));
  const allIds = actors.map((a) => a.synthetic_user_id).filter(Boolean);

  const { rows: events } = await query(
    `SELECT event_id, actor_id, trace_id, action, payload
       FROM events
      WHERE run_id = $1
        AND event_type IN ('http_request', 'late_response', 'probe')
        AND payload IS NOT NULL`,
    [runId]
  );

  const violationsByAction = new Map();

  for (const e of events) {
    const ownId = idByActor.get(e.actor_id);
    const response = e.payload?.response;
    if (!response) continue;

    const text = JSON.stringify(response);
    if (!text.includes('sim-')) continue; // cheap pre-filter

    for (const foreignId of allIds) {
      if (foreignId === ownId) continue;
      if (!containsIdentifier(text, foreignId)) continue;

      const endpoint = normalizeEndpoint(e.action);
      if (!violationsByAction.has(endpoint)) violationsByAction.set(endpoint, []);
      violationsByAction.get(endpoint).push({
        traceId: e.trace_id,
        ownIdentifier: ownId,
        leakedIdentifier: foreignId,
        action: e.action
      });
      break; // one violation per event is enough
    }
  }

  const findings = [];
  for (const [endpoint, violations] of violationsByAction) {
    const action = endpoint;
    findings.push({
      finding_id: crypto.randomUUID(),
      run_id: runId,
      severity: 'critical',
      detector: 'isolation',
      signature: { detector: 'isolation', action, kind: 'cross_actor_leak' },
      summary:
        `${endpoint} leaked data across actors: ${violations.length} response(s) served one ` +
        `actor data belonging to another. Example: the actor identified as ` +
        `${violations[0].ownIdentifier} received data belonging to ${violations[0].leakedIdentifier}.`,
      evidence_trace_ids: violations.slice(0, 5).map((v) => v.traceId),
      evidence: {
        endpoint,
        violations: violations.length,
        distinctVictims: new Set(violations.map((v) => v.ownIdentifier)).size,
        samples: violations.slice(0, 5)
      }
    });
  }

  return findings;
}

/**
 * Group by endpoint, not by the exact URL.
 *
 * Query strings carry the actor's own session id, so grouping on the raw
 * action produced one finding per actor — 56 criticals for a single missing
 * WHERE clause. Stripping the query string collapses them to one finding per
 * leaking endpoint, and keeps the fingerprint stable across runs (the
 * session id contains the seed, so it would otherwise change every run and
 * break differential comparison entirely).
 */
function normalizeEndpoint(action) {
  return String(action).split('?')[0];
}

/**
 * "sim-seed-1" must not match inside "sim-seed-12". Require the identifier to
 * be bounded by something other than a word character or hyphen.
 */
function containsIdentifier(text, id) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(id, from);
    if (at === -1) return false;
    const after = text[at + id.length];
    if (after === undefined || !/[\w-]/.test(after)) return true;
    from = at + 1;
  }
}

module.exports = { detectIsolation, containsIdentifier, normalizeEndpoint };
