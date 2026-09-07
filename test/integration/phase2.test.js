'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * Phase 2 integration: isolation detection, invariants, differential runs
 * and report formats, all against the real sample app.
 */
const MAGNUM_DB = process.env.MAGNUM_OPUS_DB_URL || 'postgres://postgres@127.0.0.1:5432/magnum_opus';
const SAMPLE_DB = process.env.SAMPLE_APP_DB_URL || 'postgres://postgres@127.0.0.1:5432/magnum_opus_sample';

async function postgresAvailable() {
  try {
    const pool = new Pool({ connectionString: MAGNUM_DB, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    await pool.end();
    return true;
  } catch (_) {
    return false;
  }
}

async function startSampleApp({ fixed = false, leak = false } = {}) {
  process.env.SAMPLE_APP_FIXED = fixed ? '1' : '';
  process.env.SAMPLE_APP_LEAK = leak ? '1' : '';
  process.env.SAMPLE_APP_SEED = `p2-${fixed}-${leak}`;
  process.env.SAMPLE_APP_SLOW_RATE = '0.6';
  process.env.SAMPLE_APP_SLOW_MS = '2000';

  for (const key of Object.keys(require.cache)) {
    if (key.includes('sample-app')) delete require.cache[key];
  }

  const { createApp } = require('../../sample-app/server');
  const pool = new Pool({ connectionString: SAMPLE_DB });
  await pool.query(fs.readFileSync(path.join(__dirname, '../../sample-app/db.sql'), 'utf8'));
  await pool.query('DELETE FROM idempotency_keys');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM cart_items');

  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(0, () => resolve(s));
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((r) => server.close(r));
      await pool.end();
    }
  };
}

const config = (baseUrl) => ({
  baseUrl,
  personaMix: { impatient_customer: 20 },
  concurrency: 8,
  idempotency: { enabled: true },
  detectors: { errorSpikes: { enabled: false }, abandonmentRate: { enabled: false } }
});

test('Phase 2 integration', { concurrency: false }, async (t) => {
  if (!(await postgresAvailable())) {
    t.skip(`Postgres unreachable at ${MAGNUM_DB} — skipping`);
    return;
  }

  const { query, closePool } = require('../../src/db/client');
  await query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
  const { runSimulation } = require('../../src/simulation');
  const { diffRuns } = require('../../src/commands/diff');
  const { toSarif } = require('../../src/report/sarif');
  const { toJUnit } = require('../../src/report/junit');

  let buggyRunId;
  let fixedRunId;

  await t.test('refuses a public target before touching anything', async () => {
    await assert.rejects(
      () => runSimulation({ config: { ...config('https://api.example.com') }, seed: 's', quiet: true }),
      (err) => err.code === 'MAGNUM_UNSAFE_TARGET'
    );
  });

  await t.test('detects the non-idempotent write and the broken invariant', async () => {
    const app = await startSampleApp({ fixed: false });
    try {
      const { runId, findings } = await runSimulation({
        config: config(app.baseUrl),
        seed: 'p2-buggy',
        quiet: true
      });
      buggyRunId = runId;

      const detectors = new Set(
        findings.filter((f) => f.severity === 'critical').map((f) => f.detector)
      );
      assert.ok(detectors.has('duplicateWrites'), 'expected a duplicateWrites critical');
      assert.ok(detectors.has('invariantViolations'), 'expected an invariant violation');
      assert.ok(!detectors.has('isolation'), 'isolation must not fire without a leak');
    } finally {
      await app.stop();
    }
  });

  await t.test('stays clean on the fixed application', async () => {
    const app = await startSampleApp({ fixed: true });
    try {
      const { runId, findings } = await runSimulation({
        config: config(app.baseUrl),
        seed: 'p2-fixed',
        quiet: true
      });
      fixedRunId = runId;
      const criticals = findings.filter((f) => f.severity === 'critical');
      assert.strictEqual(
        criticals.length,
        0,
        'false positives:\n' + criticals.map((f) => '  ' + f.summary).join('\n')
      );
      assert.ok(findings.some((f) => f.severity === 'info'), 'expected positive evidence');
    } finally {
      await app.stop();
    }
  });

  await t.test('catches a tenant leak that correct writes would hide', async () => {
    const app = await startSampleApp({ fixed: true, leak: true });
    try {
      const { findings } = await runSimulation({
        config: config(app.baseUrl),
        seed: 'p2-leak',
        quiet: true
      });
      const leaks = findings.filter((f) => f.detector === 'isolation');
      assert.strictEqual(leaks.length, 1, 'expected exactly one grouped isolation finding');
      assert.strictEqual(leaks[0].severity, 'critical');
      assert.match(leaks[0].summary, /leaked data across actors/);
      // Grouped by endpoint, so the session id must not appear in the signature.
      assert.ok(
        !JSON.stringify(leaks[0].signature).includes('sessionId='),
        'signature must not embed a per-actor session id'
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('diff reports the bug as fixed, and as new in reverse', async () => {
    const forward = await diffRuns(buggyRunId, fixedRunId);
    assert.ok(forward.resolved.length > 0, 'expected resolved findings');
    assert.strictEqual(forward.introduced.length, 0, 'nothing should be newly introduced');

    const reverse = await diffRuns(fixedRunId, buggyRunId);
    assert.ok(reverse.introduced.length > 0, 'reverse diff should report new findings');
    assert.strictEqual(
      reverse.introduced.length,
      forward.resolved.length,
      'diff must be symmetric'
    );
  });

  await t.test('emits valid SARIF and JUnit', async () => {
    const { rows } = await query(
      `SELECT severity, detector, summary, fingerprint, signature, evidence_trace_ids
         FROM findings WHERE run_id = $1`,
      [buggyRunId]
    );
    const findings = rows.map((r) => ({ ...r, signature: r.signature }));

    const sarif = toSarif({ findings, config: config('http://x'), seed: 'p2-buggy', runId: buggyRunId });
    assert.strictEqual(sarif.version, '2.1.0');
    assert.ok(sarif.runs[0].results.length > 0);
    for (const result of sarif.runs[0].results) {
      assert.ok(result.ruleId, 'every result needs a ruleId');
      assert.ok(result.locations[0].physicalLocation.artifactLocation.uri);
      assert.ok(result.partialFingerprints.magnumOpus, 'fingerprint enables dedup in GitHub');
    }
    const ruleIds = new Set(sarif.runs[0].tool.driver.rules.map((r) => r.id));
    for (const result of sarif.runs[0].results) {
      assert.ok(ruleIds.has(result.ruleId), `rule ${result.ruleId} must be declared`);
    }

    const junit = toJUnit({ findings, seed: 'p2-buggy', runId: buggyRunId });
    assert.match(junit, /^<\?xml version="1\.0"/);
    assert.match(junit, /<testsuites/);
    assert.match(junit, /<failure message=/);
    assert.ok(!junit.includes('&&'), 'XML must be escaped');
  });

  await closePool();
});
