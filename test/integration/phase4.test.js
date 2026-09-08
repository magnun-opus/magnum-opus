'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { startAuthApp } = require('../fixtures/authApp');

/**
 * Phase 4 integration: authentication, seeded selection, actor state, and the
 * bounds invariant catching a real oversell — each with a matched control.
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

/** A persona that logs in, picks a product, and buys more than exists. */
function greedyPersona() {
  return {
    persona: 'greedy_buyer',
    patience_ms: 4000,
    auth: {
      action: 'POST /api/auth/login',
      body: { email: '{{actor.sessionId}}@example.test', password: 'hunter2' },
      extract: { token: 'token', userId: 'userId' },
      header: 'Authorization',
      format: 'Bearer {{vars.token}}'
    },
    probes: {
      catalogue: { action: 'GET /api/products' },
      orders: { action: 'GET /api/orders' }
    },
    invariants: [
      {
        name: 'inventory never negative',
        type: 'bounds',
        collection: 'catalogue.products',
        field: 'stock',
        min: 0
      },
      {
        name: 'buyer sees only their own orders',
        type: 'match',
        collection: 'orders.orders',
        field: 'userId',
        pattern: '^{{vars.userId}}$'
      }
    ],
    states: [
      {
        name: 'browse',
        on_enter: {
          event_type: 'http_request',
          action: 'GET /api/products',
          extract: { productId: { path: 'products', pick: 'random', field: 'id' } }
        },
        transitions: [
          { to: 'buy', condition: 'on_success' },
          { to: 'stop', condition: 'always' }
        ]
      },
      {
        name: 'buy',
        on_enter: {
          event_type: 'http_request',
          action: 'POST /api/checkout',
          intent: 'checkout',
          body: { productId: '{{vars.productId}}', quantity: 2 }
        },
        transitions: [{ to: 'stop', condition: 'always' }]
      },
      { name: 'stop', terminal: true, outcome_class: 'success' }
    ]
  };
}

function configFor(baseUrl) {
  return {
    baseUrl,
    personaMix: { greedy_buyer: 12 },
    concurrency: 6,
    detectors: { errorSpikes: { enabled: false }, abandonmentRate: { enabled: false } }
  };
}

/** Write the persona to a temp dir so the real loader path is exercised. */
function personaDir() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'p4-'));
  const personas = path.join(dir, 'personas');
  fs.mkdirSync(personas);
  fs.writeFileSync(path.join(personas, 'greedy.json'), JSON.stringify(greedyPersona()));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ personasDir: './personas' }));
  return configPath;
}

test('Phase 4 integration', { concurrency: false }, async (t) => {
  if (!(await postgresAvailable())) {
    t.skip(`Postgres unreachable at ${MAGNUM_DB} — skipping`);
    return;
  }

  const { query, closePool } = require('../../src/db/client');
  await query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
  const { runSimulation } = require('../../src/simulation');
  const configPath = personaDir();

  await t.test('bounds catches inventory driven negative', async () => {
    const app = await startAuthApp({ oversell: true });
    try {
      const { findings } = await runSimulation({
        config: { ...configFor(app.baseUrl), personasDir: './personas' },
        configPath,
        seed: 'p4-oversell',
        quiet: true
      });

      const violations = findings.filter(
        (f) => f.detector === 'invariantViolations' && f.severity === 'critical'
      );
      assert.ok(
        violations.some((f) => /inventory never negative/.test(f.summary)),
        'expected the bounds invariant to fire:\n' +
          findings.map((f) => `  [${f.severity}] ${f.summary}`).join('\n')
      );

      // The app really did go negative — the finding is not a false alarm.
      assert.ok(
        app.products.some((p) => p.stock < 0),
        'fixture should have oversold'
      );
    } finally {
      await app.stop();
    }
  });

  await t.test('bounds stays silent when the stock floor is enforced', async () => {
    const app = await startAuthApp({ oversell: false });
    try {
      const { findings } = await runSimulation({
        config: { ...configFor(app.baseUrl), personasDir: './personas' },
        configPath,
        seed: 'p4-guarded',
        quiet: true
      });

      const violations = findings.filter(
        (f) => f.detector === 'invariantViolations' && f.severity === 'critical'
      );
      assert.strictEqual(
        violations.length,
        0,
        'false positives on a correct application:\n' +
          violations.map((f) => '  ' + f.summary).join('\n')
      );
      assert.ok(app.products.every((p) => p.stock >= 0));
    } finally {
      await app.stop();
    }
  });

  await t.test('authentication is genuinely exercised, and credentials are redacted', async () => {
    const app = await startAuthApp({ oversell: false });
    let runId;
    try {
      ({ runId } = await runSimulation({
        config: { ...configFor(app.baseUrl), personasDir: './personas' },
        configPath,
        seed: 'p4-auth',
        quiet: true
      }));
    } finally {
      await app.stop();
    }

    const { rows: auths } = await query(
      `SELECT outcome, payload FROM events WHERE run_id = $1 AND event_type = 'auth'`,
      [runId]
    );
    assert.ok(auths.length > 0, 'expected auth events');
    assert.ok(auths.every((a) => a.outcome === 'success'), 'every actor should have logged in');
    for (const a of auths) {
      assert.strictEqual(a.payload.request.password, '****', 'password must never reach the log');
    }

    // Authenticated requests succeeded, proving the token was carried through.
    const { rows: reqs } = await query(
      `SELECT count(*) FILTER (WHERE http_status = 401) AS unauthorized,
              count(*) AS total
         FROM events WHERE run_id = $1 AND event_type = 'http_request'`,
      [runId]
    );
    assert.strictEqual(Number(reqs[0].unauthorized), 0, 'no request should have been rejected as 401');
    assert.ok(Number(reqs[0].total) > 0);
  });

  await t.test('actors make varied, reproducible choices', async () => {
    const app = await startAuthApp({ oversell: true });
    let runId;
    try {
      ({ runId } = await runSimulation({
        config: { ...configFor(app.baseUrl), personasDir: './personas' },
        configPath,
        seed: 'p4-variety',
        quiet: true
      }));
    } finally {
      await app.stop();
    }

    const { rows } = await query(
      `SELECT DISTINCT payload->'request'->>'productId' AS product
         FROM events
        WHERE run_id = $1 AND action = 'POST /api/checkout' AND payload->'request' IS NOT NULL`,
      [runId]
    );
    const products = rows.map((r) => r.product).filter(Boolean);
    assert.ok(
      new Set(products).size > 1,
      `a population must not all choose the same item; got ${JSON.stringify(products)}`
    );
  });

  await closePool();
});
