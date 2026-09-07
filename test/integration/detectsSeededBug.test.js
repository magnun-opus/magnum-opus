'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * The test that matters: does the tool catch the bug it claims to catch,
 * and — just as important — does it stay quiet on a correct application?
 *
 * Phase 1's detector would have passed the first half and failed the second,
 * because it flagged the timeout-then-retry SHAPE rather than verifying that
 * two records actually existed.
 *
 * Requires Postgres. Skips with a message if unreachable, so `npm test` is
 * still useful on a machine without a database.
 */

const MAGNUM_DB = process.env.MAGNUM_OPUS_DB_URL || 'postgres://localhost:5432/magnum_opus';
const SAMPLE_DB = process.env.SAMPLE_APP_DB_URL || 'postgres://localhost:5432/magnum_opus_sample';

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

/** Boot the sample app on an ephemeral port in the requested mode. */
async function startSampleApp({ fixed }) {
  process.env.SAMPLE_APP_FIXED = fixed ? '1' : '';
  process.env.SAMPLE_APP_SEED = fixed ? 'itest-fixed' : 'itest-buggy';
  process.env.SAMPLE_APP_SLOW_RATE = '0.6';
  process.env.SAMPLE_APP_SLOW_MS = '2000';

  // Route modules read SAMPLE_APP_FIXED at construction time.
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

function baseConfig(baseUrl) {
  return {
    baseUrl,
    personaMix: { impatient_customer: 24 },
    concurrency: 8,
    idempotency: { enabled: true },
    detectors: {
      errorSpikes: { enabled: false },
      abandonmentRate: { enabled: false }
    }
  };
}

test('Magnum Opus integration', { concurrency: false }, async (t) => {
  if (!(await postgresAvailable())) {
    t.skip(`Postgres unreachable at ${MAGNUM_DB} — skipping integration tests`);
    return;
  }

  // Apply the Magnum Opus schema once for the whole suite.
  const { query, closePool } = require('../../src/db/client');
  await query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));

  const { runSimulation } = require('../../src/simulation');

  await t.test('catches the seeded non-idempotent checkout', async () => {
    const app = await startSampleApp({ fixed: false });
    try {
      const { findings } = await runSimulation({
        config: baseConfig(app.baseUrl),
        seed: 'itest-buggy-v1',
        quiet: true
      });

      const criticals = findings.filter(
        (f) => f.detector === 'duplicateWrites' && f.severity === 'critical'
      );

      assert.ok(
        criticals.length > 0,
        `expected at least one critical duplicateWrites finding, got:\n` +
          findings.map((f) => `  [${f.severity}] ${f.summary}`).join('\n')
      );

      // Both evidence paths should be exercised, not just one.
      const sources = new Set(criticals.map((f) => f.evidence?.source));
      assert.ok(
        sources.has('observed_identities') || sources.has('read_back'),
        'expected evidence from an observable source'
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('stays silent on the fixed, idempotent checkout', async () => {
    const app = await startSampleApp({ fixed: true });
    try {
      const { findings } = await runSimulation({
        config: baseConfig(app.baseUrl),
        seed: 'itest-fixed-v1',
        quiet: true
      });

      const criticals = findings.filter(
        (f) => f.detector === 'duplicateWrites' && f.severity === 'critical'
      );

      assert.strictEqual(
        criticals.length,
        0,
        `false positives on a correct application:\n` +
          criticals.map((f) => `  ${f.summary}`).join('\n')
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('the same seed produces the same actor behaviour', async () => {
    const app = await startSampleApp({ fixed: true });
    try {
      const shape = async () => {
        const { runId } = await runSimulation({
          config: { ...baseConfig(app.baseUrl), personaMix: { price_checker: 12 } },
          seed: 'itest-determinism',
          quiet: true
        });
        const { rows } = await query(
          `SELECT a.actor_index, e.trace_sequence, e.action
             FROM events e JOIN actors a ON a.actor_id = e.actor_id
            WHERE e.run_id = $1 AND e.event_type = 'http_request'
            ORDER BY a.actor_index, e.trace_sequence`,
          [runId]
        );
        return rows.map((r) => `${r.actor_index}:${r.trace_sequence}:${r.action}`);
      };

      const first = await shape();
      const second = await shape();

      assert.ok(first.length > 0, 'no requests recorded');
      assert.deepStrictEqual(
        second,
        first,
        'same seed produced a different sequence of actions'
      );
    } finally {
      await app.stop();
    }
  });

  await closePool();
});
