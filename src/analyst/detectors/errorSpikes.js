'use strict';

const crypto = require('crypto');
const { query } = require('../../db/client');

/**
 * Error-rate detector. Thresholds are configuration, not constants baked
 * into the source — different applications have different tolerances.
 *
 *   rate = (errors + client_timeouts) / total_requests
 */
async function detectErrorSpikes(runId, options = {}) {
  const warnAt = options.warnAt ?? 0.15;
  const criticalAt = options.criticalAt ?? 0.3;

  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE outcome = 'error')   AS error_count,
       count(*) FILTER (WHERE outcome = 'timeout') AS timeout_count,
       count(*)                                    AS total
     FROM events
     WHERE run_id = $1 AND event_type = 'http_request'`,
    [runId]
  );

  const errorCount = Number(rows[0].error_count);
  const timeoutCount = Number(rows[0].timeout_count);
  const total = Number(rows[0].total);
  if (total === 0) return [];

  const rate = (errorCount + timeoutCount) / total;
  if (rate < warnAt) return [];

  return [
    {
      finding_id: crypto.randomUUID(),
      run_id: runId,
      severity: rate >= criticalAt ? 'critical' : 'warning',
      detector: 'errorSpikes',
      signature: { detector: 'errorSpikes', kind: 'rate_above_threshold' },
      summary:
        `${(rate * 100).toFixed(1)}% of requests errored or exceeded client patience ` +
        `(${errorCount} errors, ${timeoutCount} timeouts of ${total} requests).`,
      evidence_trace_ids: [],
      evidence: { errorCount, timeoutCount, total, rate, warnAt, criticalAt }
    }
  ];
}

module.exports = { detectErrorSpikes };
