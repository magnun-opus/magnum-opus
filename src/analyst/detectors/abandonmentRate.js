'use strict';

const crypto = require('crypto');
const { query } = require('../../db/client');

/**
 * Abandonment detector.
 *
 * Phase 1 keyed on a persona state literally being named `abandon` — rename
 * the state and the detector silently returned zero findings. Terminal
 * states now declare an explicit `outcome_class`, which the engine writes
 * into the outcome column, so the detector is decoupled from state naming.
 */
async function detectAbandonmentRate(runId, options = {}) {
  const threshold = options.threshold ?? 0.25;

  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE outcome = 'abandon') AS abandoned,
       count(*)                                    AS total
     FROM events
     WHERE run_id = $1 AND event_type = 'decision' AND action LIKE 'terminal:%'`,
    [runId]
  );

  const abandoned = Number(rows[0].abandoned);
  const total = Number(rows[0].total);
  if (total === 0) return [];

  const rate = abandoned / total;
  if (rate < threshold) return [];

  return [
    {
      finding_id: crypto.randomUUID(),
      run_id: runId,
      severity: 'warning',
      detector: 'abandonmentRate',
      signature: { detector: 'abandonmentRate', kind: 'rate_above_threshold' },
      summary:
        `${(rate * 100).toFixed(1)}% of actors abandoned before completing their flow ` +
        `(${abandoned} of ${total}). Investigate latency or reliability on the checkout path.`,
      evidence_trace_ids: [],
      evidence: { abandoned, total, rate, threshold }
    }
  ];
}

module.exports = { detectAbandonmentRate };
