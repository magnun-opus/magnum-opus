'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * Phase 3 integration: chaos injection and epoch-based degradation, both
 * against the real sample app with matched controls.
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

async function startSampleApp({ fixed = false, scan = false, slowRate = '0' } = {}) {
  process.env.SAMPLE_APP_FIXED = fixed ? '1' : '';
  process.env.SAMPLE_APP_LEAK = '';
  process.env.SAMPLE_APP_SCAN = scan ? '1' : '';
  process.env.SAMPLE_APP_SLOW_RATE = slowRate;

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
    pool,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((r) => server.close(r));
      await pool.end();
    }
  };
}

const base = (baseUrl, extra = {}) => ({
  baseUrl,
  personaMix: { impatient_customer: 16 },
  concurrency: 8,
  idempotency: { enabled: true },
  detectors: { errorSpikes: { enabled: false }, abandonmentRate: { enabled: false } },
  ...extra
});

test('Phase 3 integration', { concurrency: false }, async (t) => {
  if (!(await postgresAvailable())) {
    t.skip(`Postgres unreachable at ${MAGNUM_DB} — skipping`);
    return;
  }

  const { query, closePool } = require('../../src/db/client');
  await query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
  const { runSimulation } = require('../../src/simulation');

  await t.test('chaos finds a duplicate that a well-behaved client never would', async () => {
    // The app is fast, so no client ever times out and no client ever
    // retries. Any duplicate must come from the injected proxy retry alone.
    const clean = await startSampleApp({ fixed: false, slowRate: '0' });
    let baselineCriticals;
    try {
      const { findings } = await runSimulation({
        config: base(clean.baseUrl),
        seed: 'p3-nochaos',
        quiet: true
      });
      baselineCriticals = findings.filter((f) => f.severity === 'critical');
      assert.strictEqual(
        baselineCriticals.length,
        0,
        'without chaos the bug should stay hidden on a fast app'
      );
    } finally {
      await clean.stop();
    }

    const chaotic = await startSampleApp({ fixed: false, slowRate: '0' });
    try {
      const { findings, chaosDuplicates } = await runSimulation({
        config: base(chaotic.baseUrl, { chaos: { enabled: true, rate: 0.4 } }),
        seed: 'p3-chaos',
        quiet: true
      });
      assert.ok(chaosDuplicates > 0, 'expected duplicate faults to have been injected');
      const criticals = findings.filter((f) => f.severity === 'critical');
      assert.ok(
        criticals.length > 0,
        'chaos should surface the non-idempotent write:\n' +
          findings.map((f) => `  [${f.severity}] ${f.summary}`).join('\n')
      );
    } finally {
      await chaotic.stop();
    }
  });

  await t.test('chaos does not break a correctly idempotent application', async () => {
    const app = await startSampleApp({ fixed: true, slowRate: '0' });
    try {
      const { findings } = await runSimulation({
        config: base(app.baseUrl, { chaos: { enabled: true, rate: 0.4 } }),
        seed: 'p3-chaos-fixed',
        quiet: true
      });
      const criticals = findings.filter((f) => f.severity === 'critical');
      assert.strictEqual(
        criticals.length,
        0,
        'false positives under chaos:\n' + criticals.map((f) => '  ' + f.summary).join('\n')
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('epochs detect a sequential scan, and stay quiet on an index', async () => {
    const accrete = (pool) => async ({ epoch }) => {
      await pool.query(
        `INSERT INTO orders (session_id, total_cents)
         SELECT 'hist-' || $1 || '-' || g, 1000 FROM generate_series(1, 30000) AS g`,
        [epoch]
      );
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
      return { size: rows[0].n };
    };

    const epochConfig = { count: 4, stepDays: 30 };

    // Scan: the index is defeated by an expression on the column.
    const scanning = await startSampleApp({ fixed: true, scan: true, slowRate: '0' });
    let scanFindings;
    try {
      const { findings } = await runSimulation({
        config: base(scanning.baseUrl, {
          personaMix: { impatient_customer: 8 },
          epochs: epochConfig
        }),
        seed: 'p3-scan',
        quiet: true,
        onEpochStart: accrete(scanning.pool)
      });
      scanFindings = findings.filter((f) => f.detector === 'temporalDegradation');
    } finally {
      await scanning.stop();
    }

    assert.ok(
      scanFindings.length > 0,
      'expected temporalDegradation on a sequential scan over a growing table'
    );
    assert.ok(scanFindings[0].evidence.exponent > 0.5, 'exponent should indicate real growth');
    assert.ok(scanFindings[0].evidence.r2 >= 0.7, 'fit guard should hold');

    // Control: identical accretion, index intact.
    const indexed = await startSampleApp({ fixed: true, scan: false, slowRate: '0' });
    try {
      const { findings } = await runSimulation({
        config: base(indexed.baseUrl, {
          personaMix: { impatient_customer: 8 },
          epochs: epochConfig
        }),
        seed: 'p3-indexed',
        quiet: true,
        onEpochStart: accrete(indexed.pool)
      });
      const degradations = findings.filter((f) => f.detector === 'temporalDegradation');
      assert.strictEqual(
        degradations.length,
        0,
        'an indexed lookup under identical growth must not be reported:\n' +
          degradations.map((f) => '  ' + f.summary).join('\n')
      );
    } finally {
      await indexed.stop();
    }
  });

  await t.test('epochs are recorded and verification runs per wave', async () => {
    const { rows } = await query(
      `SELECT DISTINCT epoch FROM events
        WHERE run_id = (SELECT run_id FROM simulation_runs ORDER BY started_at DESC LIMIT 1)
          AND event_type = 'invariant'
        ORDER BY epoch`
    );
    assert.ok(rows.length > 1, 'invariants should be evaluated in more than one epoch');
  });

  await closePool();
});
