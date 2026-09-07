'use strict';

const crypto = require('crypto');
const { query } = require('../../db/client');

/**
 * Detects performance that degrades as world state accumulates.
 *
 * Across epochs, latency is fitted against cumulative record count on a
 * log-log scale:
 *
 *     log(L) = k · log(n) + c
 *     k = Σ((x − x̄)(y − ȳ)) / Σ((x − x̄)²)     where x = log n, y = log L
 *
 * The exponent k is the shape of the curve:
 *     k ≈ 0   constant time — an indexed lookup, healthy
 *     k ≈ 0.5 sub-linear
 *     k ≈ 1   linear in data size — a full table scan
 *
 * Three guards against reporting noise, all of which must pass:
 *   1. R² ≥ minFit — the points must actually lie on a line. Without this a
 *      slope computed from scatter looks like a trend.
 *   2. latency must at least double from first epoch to last.
 *   3. final latency must exceed a floor, so a query going from 0.4ms to
 *      1.2ms is not reported as a crisis.
 *
 * This is the class of bug no single-wave load test reaches: everything is
 * fine at a hundred rows and falls over at fifty thousand.
 */
function leastSquares(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  if (sxx === 0) return { slope: 0, intercept: meanY, r2: 0 };

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

async function detectTemporalDegradation(runId, options = {}) {
  if (options.enabled === false) return [];

  const exponentThreshold = options.exponentThreshold ?? 0.6;
  const minFit = options.minFit ?? 0.7;
  const minLatencyMs = options.minLatencyMs ?? 25;
  const minEpochs = options.minEpochs ?? 3;

  // p95 latency per action per epoch, alongside how much data existed by then.
  const { rows } = await query(
    `SELECT epoch,
            action,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
            count(*) AS samples
       FROM events
      WHERE run_id = $1
        AND event_type IN ('http_request', 'probe')
        AND outcome = 'success'
        AND latency_ms IS NOT NULL
        AND epoch > 0
      GROUP BY epoch, action
      ORDER BY action, epoch`,
    [runId]
  );
  if (rows.length === 0) return [];

  // Cumulative successful writes are the proxy for accumulated world state.
  const { rows: volumeRows } = await query(
    `SELECT epoch, count(*) AS writes
       FROM events
      WHERE run_id = $1
        AND event_type IN ('http_request', 'late_response')
        AND idempotency_key IS NOT NULL
        AND outcome = 'success'
        AND epoch > 0
      GROUP BY epoch ORDER BY epoch`,
    [runId]
  );

  const cumulative = new Map();
  let running = 0;
  for (const v of volumeRows) {
    running += Number(v.writes);
    cumulative.set(Number(v.epoch), running);
  }

  // If the harness reported actual world size per epoch, prefer it: the
  // simulation's own writes are a poor proxy when the world also grows from
  // everything else happening in it.
  const { rows: worldRows } = await query(
    `SELECT epoch, max((payload->>'size')::bigint) AS size
       FROM events
      WHERE run_id = $1 AND event_type = 'world_state' AND epoch > 0
      GROUP BY epoch`,
    [runId]
  );
  for (const w of worldRows) {
    if (w.size != null) cumulative.set(Number(w.epoch), Number(w.size));
  }

  if (cumulative.size < minEpochs) return [];

  const byAction = new Map();
  for (const r of rows) {
    const action = String(r.action).split('?')[0]; // group by endpoint, not URL
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push({
      epoch: Number(r.epoch),
      p95: Number(r.p95),
      records: cumulative.get(Number(r.epoch)) || 0
    });
  }

  const findings = [];

  for (const [action, series] of byAction) {
    const points = series
      .filter((p) => p.records > 0 && p.p95 > 0)
      .sort((a, b) => a.epoch - b.epoch);
    if (points.length < minEpochs) continue;

    const first = points[0];
    const last = points[points.length - 1];

    const { slope, r2 } = leastSquares(
      points.map((p) => Math.log(p.records)),
      points.map((p) => Math.log(p.p95))
    );

    const grew = last.p95 >= first.p95 * 2;
    const material = last.p95 >= minLatencyMs;
    const shaped = r2 >= minFit;

    if (!(slope >= exponentThreshold && grew && material && shaped)) continue;

    const severity = slope >= 0.9 ? 'critical' : 'warning';

    findings.push({
      finding_id: crypto.randomUUID(),
      run_id: runId,
      severity,
      detector: 'temporalDegradation',
      signature: { detector: 'temporalDegradation', action, kind: 'superlinear_growth' },
      summary:
        `${action} degrades as data accumulates: p95 rose from ${first.p95.toFixed(0)}ms at ` +
        `${first.records} record(s) to ${last.p95.toFixed(0)}ms at ${last.records}. ` +
        `Growth exponent k=${slope.toFixed(2)} (R²=${r2.toFixed(2)}) — ` +
        (slope >= 0.9
          ? 'consistent with a full table scan. Check for a missing index.'
          : 'growth is sub-linear but material as the table grows.'),
      evidence_trace_ids: [],
      evidence: {
        action,
        exponent: Number(slope.toFixed(3)),
        r2: Number(r2.toFixed(3)),
        firstEpoch: { epoch: first.epoch, p95: first.p95, records: first.records },
        lastEpoch: { epoch: last.epoch, p95: last.p95, records: last.records },
        series: points
      }
    });
  }

  return findings;
}

module.exports = { detectTemporalDegradation, leastSquares };
