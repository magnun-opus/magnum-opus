'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { startTrpcApp } = require('../fixtures/trpcApp');

/**
 * Phase 5: tRPC end to end, and the HTML report.
 */
const MAGNUM_DB = process.env.MAGNUM_OPUS_DB_URL || 'postgres://postgres@127.0.0.1:5432/magnum_opus';

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

/** Scaffold the shipped banking-trpc pack into a temp project. */
function trpcProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trpc-'));
  const { init } = require('../../src/commands/init');
  const quiet = console.log;
  console.log = () => {};
  try {
    init({ cwd, domain: 'banking-trpc' });
  } finally {
    console.log = quiet;
  }
  return path.join(cwd, 'magnum', 'config.json');
}

test('Phase 5 integration', { concurrency: false }, async (t) => {
  if (!(await postgresAvailable())) {
    t.skip(`Postgres unreachable at ${MAGNUM_DB} — skipping`);
    return;
  }

  const { query, closePool } = require('../../src/db/client');
  await query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
  const { runSimulation } = require('../../src/simulation');
  const { buildHtmlReport } = require('../../src/report/html');

  const configPath = trpcProject();
  const baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let trpcRunId;

  await t.test('the shipped tRPC pack runs against a real tRPC app', async () => {
    const app = await startTrpcApp({ transformer: 'superjson' });
    try {
      const { runId, findings } = await runSimulation({
        config: {
          ...baseConfig,
          baseUrl: app.baseUrl,
          personaMix: { trpc_customer: 10 },
          concurrency: 5,
          detectors: { errorSpikes: { enabled: false }, abandonmentRate: { enabled: false } }
        },
        configPath,
        seed: 'p5-trpc',
        quiet: true
      });
      trpcRunId = runId;

      // Requests actually reached procedures and succeeded.
      const { rows } = await query(
        `SELECT action, count(*) AS n,
                count(*) FILTER (WHERE outcome = 'success') AS ok
           FROM events WHERE run_id = $1 AND event_type = 'http_request' GROUP BY 1`,
        [runId]
      );
      assert.ok(rows.length > 0, 'expected requests');
      for (const r of rows) {
        assert.match(r.action, /\/api\/trpc\/banking\./, 'actions should name procedures');
        assert.ok(!r.action.includes('?input='), 'the query string must not appear in the action');
      }
      assert.ok(rows.some((r) => Number(r.ok) > 0), 'some procedures should have succeeded');

      // Invariants were genuinely evaluated, not skipped by an envelope path.
      const { rows: inv } = await query(
        `SELECT outcome, count(*) AS n FROM events
          WHERE run_id = $1 AND event_type = 'invariant' GROUP BY 1`,
        [runId]
      );
      const outcomes = Object.fromEntries(inv.map((r) => [r.outcome, Number(r.n)]));
      assert.ok(
        (outcomes.held || 0) + (outcomes.violated || 0) > 0,
        `invariants must be evaluated, not skipped: ${JSON.stringify(outcomes)}`
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('bounds catches a negative balance through the envelope', async () => {
    // The fixture lets balances go negative; the persona spends beyond it.
    const app = await startTrpcApp({ transformer: 'superjson' });
    try {
      const { findings } = await runSimulation({
        config: {
          ...baseConfig,
          baseUrl: app.baseUrl,
          personaMix: { trpc_impatient: 12 },
          concurrency: 6,
          detectors: { errorSpikes: { enabled: false }, abandonmentRate: { enabled: false } }
        },
        configPath,
        seed: 'p5-bounds',
        quiet: true
      });
      // Whatever the outcome, no invariant may be unverifiable for envelope reasons.
      const unverifiable = findings.filter((f) => /could not be checked/.test(f.summary));
      assert.strictEqual(
        unverifiable.length,
        0,
        'the envelope should never make invariants unverifiable:\n' +
          unverifiable.map((f) => '  ' + f.summary).join('\n')
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('the HTML report is self-contained and escapes its content', async () => {
    const { html } = await buildHtmlReport(trpcRunId);

    assert.match(html, /^<!doctype html>/i);
    assert.ok(!/src="https?:|href="https?:|@import/.test(html), 'must have no external assets');
    assert.match(html, /<h2>Findings<\/h2>/);
    assert.match(html, /<h2>Endpoints<\/h2>/);
    assert.match(html, /class="timeline"/);
    assert.match(html, /--seed/, 'must show how to reproduce the run');

    // Payloads are JSON inside HTML; a raw < would break the document.
    const body = html.slice(html.indexOf('<body'));
    const scriptTags = body.match(/<script/g) || [];
    assert.strictEqual(scriptTags.length, 0, 'no scripts should be injected from data');
  });

  await t.test('report renders a run with no findings without crashing', async () => {
    const { rows } = await query(
      `INSERT INTO simulation_runs (run_id, config, seed, started_at, status)
       VALUES (gen_random_uuid(), '{"baseUrl":"http://x"}', 'empty', now(), 'completed')
       RETURNING run_id`
    );
    const { html } = await buildHtmlReport(rows[0].run_id);
    assert.match(html, /No findings from the enabled detectors/);
  });

  await closePool();
});
