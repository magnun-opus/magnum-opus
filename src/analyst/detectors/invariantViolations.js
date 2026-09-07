'use strict';

const crypto = require('crypto');
const { query } = require('../../db/client');

/**
 * Reports invariants that failed during post-run verification.
 *
 * The engine evaluates invariants per actor and logs one `invariant` event
 * each. This aggregates them by invariant name, because one broken business
 * rule affecting sixty actors is one finding.
 */
const SEVERITY_BY_TYPE = {
  count: 'critical',
  unique: 'critical',
  conservation: 'critical',
  bounds: 'critical',
  match: 'critical'
};

async function detectInvariantViolations(runId, options = {}) {
  if (options.enabled === false) return [];

  const { rows } = await query(
    `SELECT trace_id, action, outcome, payload
       FROM events
      WHERE run_id = $1 AND event_type = 'invariant'`,
    [runId]
  );

  const grouped = new Map();
  for (const r of rows) {
    const name = r.payload?.name || r.action;
    if (!grouped.has(name)) {
      grouped.set(name, {
        name,
        type: r.payload?.type,
        failed: [],
        passed: 0,
        skipped: 0,
        reasons: [],
        skippedTraces: []
      });
    }
    const g = grouped.get(name);
    if (r.outcome === 'violated') g.failed.push({ traceId: r.trace_id, detail: r.payload?.detail, message: r.payload?.message });
    else if (r.outcome === 'skipped') {
      g.skipped++;
      g.skippedTraces.push(r.trace_id);
      const why = r.payload?.detail?.reason || r.payload?.message;
      if (why && !g.reasons.includes(why)) g.reasons.push(why);
    }
    else g.passed++;
  }

  const findings = [];
  for (const g of grouped.values()) {
    if (g.failed.length > 0) {
      const severity = options.severity || SEVERITY_BY_TYPE[g.type] || 'warning';
      findings.push({
        finding_id: crypto.randomUUID(),
        run_id: runId,
        severity,
        detector: 'invariantViolations',
        signature: { detector: 'invariantViolations', invariant: g.name, type: g.type },
        summary:
          `Invariant "${g.name}" violated for ${g.failed.length} actor(s). ` +
          `Example: ${g.failed[0].message}`,
        evidence_trace_ids: g.failed.slice(0, 5).map((f) => f.traceId),
        evidence: {
          invariant: g.name,
          type: g.type,
          violated: g.failed.length,
          held: g.passed,
          skipped: g.skipped,
          samples: g.failed.slice(0, 5)
        }
      });
    } else if (g.passed === 0 && g.skipped > 0) {
      // Every check was skipped — usually an unreachable probe. Reporting
      // nothing here would be a second kind of false green: the run looks
      // clean because nothing could be verified, not because it passed.
      const reason = g.reasons[0] || 'no evidence was available';
      findings.push({
        finding_id: crypto.randomUUID(),
        run_id: runId,
        severity: 'warning',
        detector: 'invariantViolations',
        signature: { detector: 'invariantViolations', invariant: g.name, kind: 'unverifiable' },
        summary:
          `Invariant "${g.name}" could not be checked for any of ${g.skipped} actor(s): ${reason}. ` +
          `This run proves nothing about it either way.`,
        evidence_trace_ids: g.skippedTraces.slice(0, 5),
        evidence: { invariant: g.name, type: g.type, skipped: g.skipped, reason }
      });
    } else if (g.passed > 0) {
      findings.push({
        finding_id: crypto.randomUUID(),
        run_id: runId,
        severity: 'info',
        detector: 'invariantViolations',
        signature: { detector: 'invariantViolations', invariant: g.name, kind: 'held' },
        summary: `Invariant "${g.name}" held for all ${g.passed} actor(s) checked.`,
        evidence_trace_ids: [],
        evidence: { invariant: g.name, type: g.type, held: g.passed, skipped: g.skipped }
      });
    }
  }

  return findings;
}

module.exports = { detectInvariantViolations };
