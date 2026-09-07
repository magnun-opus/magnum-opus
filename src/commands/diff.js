'use strict';

const { query } = require('../db/client');

/**
 * Differential analysis between two runs.
 *
 * Findings are matched by fingerprint — derived from a detector's signature,
 * never from counts — so "POST /checkout is not idempotent" matches itself
 * across runs even when it affected 14 actors in one and 18 in the other.
 *
 *   new       = candidate \ baseline
 *   fixed     = baseline \ candidate
 *   unchanged = baseline ∩ candidate
 *
 * This is what makes the tool a merge gate rather than a report: you care
 * about what your change introduced, not the standing backlog.
 */
async function loadFindings(runId) {
  const { rows } = await query(
    `SELECT fingerprint, severity, detector, summary, signature
       FROM findings WHERE run_id = $1`,
    [runId]
  );
  const map = new Map();
  for (const r of rows) {
    if (r.severity === 'info') continue;
    if (!map.has(r.fingerprint)) map.set(r.fingerprint, r);
  }
  return map;
}

async function diffRuns(baselineRunId, candidateRunId) {
  const [baseline, candidate] = await Promise.all([
    loadFindings(baselineRunId),
    loadFindings(candidateRunId)
  ]);

  const introduced = [];
  const resolved = [];
  const unchanged = [];

  for (const [fp, finding] of candidate) {
    if (baseline.has(fp)) unchanged.push(finding);
    else introduced.push(finding);
  }
  for (const [fp, finding] of baseline) {
    if (!candidate.has(fp)) resolved.push(finding);
  }

  return { baselineRunId, candidateRunId, introduced, resolved, unchanged };
}

/**
 * Flake filter across repeated runs of the same seed.
 *
 * The application under test, its database and the network remain sources of
 * variation even with a fixed seed, so a finding seen once in five runs is
 * probably noise. Keeps only fingerprints appearing in at least
 * minOccurrences of the runs, and records the observed rate.
 *
 *   stability = occurrences / runCount
 */
async function filterFlaky(runIds, minOccurrences = 2) {
  const perRun = await Promise.all(runIds.map(loadFindings));

  const occurrences = new Map();
  for (const map of perRun) {
    for (const [fp, finding] of map) {
      if (!occurrences.has(fp)) occurrences.set(fp, { finding, count: 0 });
      occurrences.get(fp).count++;
    }
  }

  const stable = [];
  const flaky = [];
  for (const { finding, count } of occurrences.values()) {
    const entry = {
      ...finding,
      occurrences: count,
      runCount: runIds.length,
      stability: count / runIds.length
    };
    (count >= minOccurrences ? stable : flaky).push(entry);
  }

  return { stable, flaky, runCount: runIds.length, minOccurrences };
}

function printDiff(result) {
  const line = '='.repeat(64);
  console.log(`\n${line}\nMAGNUM OPUS — DIFFERENTIAL REPORT\n${line}`);
  console.log(`Baseline:  ${result.baselineRunId}`);
  console.log(`Candidate: ${result.candidateRunId}\n`);
  console.log(
    `${result.introduced.length} new   ${result.resolved.length} fixed   ` +
      `${result.unchanged.length} unchanged\n`
  );

  const section = (label, items) => {
    if (items.length === 0) return;
    console.log(`${label}`);
    for (const f of items) console.log(`  [${f.severity}] ${f.detector}: ${f.summary}`);
    console.log('');
  };

  section('NEW — introduced by this change:', result.introduced);
  section('FIXED — no longer present:', result.resolved);
  section('UNCHANGED — pre-existing:', result.unchanged);
  console.log(line + '\n');
}

module.exports = { diffRuns, filterFlaky, loadFindings, printDiff };
