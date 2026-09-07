'use strict';

const crypto = require('crypto');
const { query } = require('../../db/client');

/**
 * Duplicate-write oracle.
 *
 * Phase 1 flagged any trace shaped "timeout -> retry -> success" and called
 * it critical. That is a guess, not a measurement: it fires on correctly
 * idempotent applications, which is the worst failure mode a testing tool
 * can have. This version proves the claim two independent ways.
 *
 * EVIDENCE SOURCE 1 — observed identities.
 *   Attempts are grouped by idempotency_key (one key per logical intent,
 *   reused across retries). Every response for that key is collected,
 *   INCLUDING late_response events: requests the client gave up on but the
 *   server completed anyway. Then per intent:
 *
 *     |distinct ids| >= 2  -> confirmed duplicate
 *     |distinct ids| == 1  -> the app honoured the key (recorded as info,
 *                             so a clean run produces positive evidence
 *                             rather than silence)
 *     |distinct ids| == 0  -> unverified, no response ever observed
 *
 * EVIDENCE SOURCE 2 — read-back verification.
 *   The runner asks the application how many records exist for the actor's
 *   session and compares against intents issued. actual > expected is a
 *   confirmed duplicate even when no response was ever observed.
 *
 * Findings are AGGREGATED PER ENDPOINT. One defect affecting sixty actors
 * is one defect; emitting sixty identical criticals buries the other
 * findings and makes the report unreadable.
 */

const DEFAULT_IDENTITY_FIELDS = ['orderId', 'order_id', 'id', 'transactionId', 'reference'];
const MAX_SAMPLE_TRACES = 5;

function extractIdentity(responseBody, fields) {
  if (!responseBody || typeof responseBody !== 'object') return null;
  for (const field of fields) {
    if (responseBody[field] != null) return String(responseBody[field]);
  }
  return null;
}

async function detectDuplicateWrites(runId, options = {}) {
  const identityFields = options.identityFields || DEFAULT_IDENTITY_FIELDS;
  const findings = [];

  // --- Source 1: attempts grouped by logical intent -----------------------
  const { rows: events } = await query(
    `SELECT trace_id, idempotency_key, attempt_number, event_type, action,
            outcome, payload
       FROM events
      WHERE run_id = $1
        AND idempotency_key IS NOT NULL
        AND event_type IN ('http_request', 'late_response')
      ORDER BY trace_sequence ASC`,
    [runId]
  );

  const intents = new Map();
  for (const e of events) {
    if (!intents.has(e.idempotency_key)) {
      intents.set(e.idempotency_key, { traceId: e.trace_id, action: e.action, attempts: [] });
    }
    intents.get(e.idempotency_key).attempts.push(e);
  }

  // action -> { confirmed, honoured, unverified }
  const byAction = new Map();
  const bucket = (action) => {
    if (!byAction.has(action)) {
      byAction.set(action, { confirmed: [], honoured: [], unverified: [] });
    }
    return byAction.get(action);
  };

  for (const [key, intent] of intents) {
    const attemptNumbers = new Set(intent.attempts.map((a) => a.attempt_number));
    if (attemptNumbers.size < 2) continue; // single attempt: nothing to compare

    const identities = new Set();
    for (const a of intent.attempts) {
      if (a.outcome !== 'success') continue;
      const id = extractIdentity(a.payload?.response, identityFields);
      if (id) identities.add(id);
    }

    const record = {
      idempotencyKey: key,
      traceId: intent.traceId,
      attempts: attemptNumbers.size,
      records: [...identities]
    };

    if (identities.size >= 2) bucket(intent.action).confirmed.push(record);
    else if (identities.size === 1) bucket(intent.action).honoured.push(record);
    else bucket(intent.action).unverified.push(record);
  }

  for (const [action, group] of byAction) {
    if (group.confirmed.length > 0) {
      const example = group.confirmed[0];
      findings.push({
        finding_id: crypto.randomUUID(),
        run_id: runId,
        severity: 'critical',
        detector: 'duplicateWrites',
        signature: { detector: 'duplicateWrites', action, kind: 'not_idempotent' },
        summary:
          `${action} is not idempotent. ${group.confirmed.length} intent(s) each produced more ` +
          `than one record despite every attempt carrying the same Idempotency-Key. ` +
          `Example: ${example.attempts} attempts created records ${example.records.join(' and ')}.`,
        evidence_trace_ids: group.confirmed.slice(0, MAX_SAMPLE_TRACES).map((r) => r.traceId),
        evidence: {
          source: 'observed_identities',
          action,
          affectedIntents: group.confirmed.length,
          samples: group.confirmed.slice(0, MAX_SAMPLE_TRACES)
        }
      });
    }

    if (group.unverified.length > 0) {
      findings.push({
        finding_id: crypto.randomUUID(),
        run_id: runId,
        severity: 'warning',
        detector: 'duplicateWrites',
        signature: { detector: 'duplicateWrites', action, kind: 'unverified' },
        summary:
          `${action} could not be verified for ${group.unverified.length} intent(s): multiple ` +
          `attempts were made but no response was ever observed, so whether duplicate records ` +
          `exist is unknown. Configure a read-back endpoint to close this gap.`,
        evidence_trace_ids: group.unverified.slice(0, MAX_SAMPLE_TRACES).map((r) => r.traceId),
        evidence: {
          source: 'observed_identities',
          action,
          affectedIntents: group.unverified.length
        }
      });
    }

    if (group.honoured.length > 0 && group.confirmed.length === 0) {
      findings.push({
        finding_id: crypto.randomUUID(),
        run_id: runId,
        severity: 'info',
        detector: 'duplicateWrites',
        signature: { detector: 'duplicateWrites', action, kind: 'honoured' },
        summary:
          `${action} honoured idempotency: ${group.honoured.length} intent(s) were retried and ` +
          `each resolved to a single record.`,
        evidence_trace_ids: group.honoured.slice(0, MAX_SAMPLE_TRACES).map((r) => r.traceId),
        evidence: {
          source: 'observed_identities',
          action,
          verifiedIntents: group.honoured.length
        }
      });
    }
  }

  // --- Source 2: read-back verification against the app's own state -------
  const { rows: mismatches } = await query(
    `SELECT trace_id, action, payload
       FROM events
      WHERE run_id = $1 AND event_type = 'verification' AND outcome = 'mismatch'`,
    [runId]
  );

  if (mismatches.length > 0) {
    const totalExtra = mismatches.reduce((sum, m) => sum + Number(m.payload?.delta || 0), 0);
    const endpoint = mismatches[0].action.split('?')[0];
    findings.push({
      finding_id: crypto.randomUUID(),
      run_id: runId,
      severity: 'critical',
      detector: 'duplicateWrites',
      signature: { detector: 'duplicateWrites', action: endpoint, kind: 'read_back_mismatch' },
      summary:
        `Read-back verification failed for ${mismatches.length} session(s): the application holds ` +
        `${totalExtra} record(s) that no actor asked for. Verified via ${endpoint} after every ` +
        `in-flight request had settled, so these are writes that landed from requests the client ` +
        `had already given up on.`,
      evidence_trace_ids: mismatches.slice(0, MAX_SAMPLE_TRACES).map((m) => m.trace_id),
      evidence: {
        source: 'read_back',
        affectedSessions: mismatches.length,
        extraRecords: totalExtra,
        samples: mismatches.slice(0, MAX_SAMPLE_TRACES).map((m) => m.payload)
      }
    });
  }

  return findings;
}

module.exports = { detectDuplicateWrites, extractIdentity };
