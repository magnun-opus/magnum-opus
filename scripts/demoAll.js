#!/usr/bin/env node
'use strict';

/**
 * One-command demo.
 *
 * Boots the sample app in-process on an ephemeral port, runs the simulation
 * against it, then shuts it down. This removes the two-terminal dance and
 * the port collision that happens when Postgres itself occupies 4000.
 *
 *   npm run demo:all              buggy app, expect critical findings
 *   npm run demo:all -- --fixed   idempotent app, expect none
 */
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');

async function main() {
  const fixed = process.argv.includes('--fixed');
  const leak = process.argv.includes('--leak');
  const scan = process.argv.includes('--scan');
  const chaos = process.argv.includes('--chaos');
  const epochs = process.argv.includes('--epochs');
  process.env.SAMPLE_APP_FIXED = fixed ? '1' : '';
  process.env.SAMPLE_APP_LEAK = leak ? '1' : '';
  process.env.SAMPLE_APP_SCAN = scan ? '1' : '';

  const { createPool } = require('../sample-app/db');
  const pool = createPool();

  const mode = [
    fixed ? 'FIXED' : 'BUGGY',
    leak ? 'LEAKING' : null,
    scan ? 'SEQ-SCAN' : null,
    chaos ? 'CHAOS' : null,
    epochs ? 'EPOCHS' : null
  ]
    .filter(Boolean)
    .join(' + ');
  console.log(`Preparing sample app (${mode})...`);
  await pool.query(fs.readFileSync(path.join(__dirname, '../sample-app/db.sql'), 'utf8'));
  await pool.query('DELETE FROM idempotency_keys');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM cart_items');

  const { createApp } = require('../sample-app/server');
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Sample app listening on ${baseUrl}\n`);

  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config/demo.json'), 'utf8')
  );
  config.baseUrl = baseUrl;

  if (chaos) config.chaos = { enabled: true, rate: 0.25 };
  if (epochs) {
    // Fewer actors per wave, several waves: the point is accumulation over
    // time, not peak concurrency.
    config.epochs = { count: 5, stepDays: 90 };
    config.personaMix = { impatient_customer: 14 };
    config.detectors = { ...(config.detectors || {}), abandonmentRate: { enabled: false } };
  }

  const { runSimulation } = require('../src/simulation');
  const { closePool } = require('../src/db/client');

  let code = 0;
  try {
    const seed = process.env.MAGNUM_SEED || 'demo-all';

    // For the epochs demo, age the world between waves. Actors accrete state
    // by running, but months of real elapsed time accrete far more — this
    // stands in for every other user's orders piling up.
    const onEpochStart = epochs
      ? async ({ epoch }) => {
          const rowsPerEpoch = Number(process.env.DEMO_ACCRETION || 40000);
          await pool.query(
            `INSERT INTO orders (session_id, total_cents)
             SELECT 'historical-' || $1 || '-' || g, 1000 + (g % 5000)
               FROM generate_series(1, $2) AS g`,
            [epoch, rowsPerEpoch]
          );
          const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
          console.log(`  world state: ${rows[0].n.toLocaleString()} orders`);
          return { size: rows[0].n };
        }
      : null;

    const { runId, findings } = await runSimulation({ config, seed, onEpochStart });

    const count = (s) => findings.filter((f) => f.severity === s).length;
    console.log('\n' + '='.repeat(64));
    console.log(`DEMO RESULT — sample app in ${mode} mode`);
    console.log('='.repeat(64));
    console.log(`${count('critical')} Critical   ${count('warning')} Warning   ${count('info')} Info\n`);
    for (const f of findings) {
      console.log(`[${f.severity.toUpperCase().padEnd(8)}] ${f.detector}`);
      console.log(`  ${f.summary}\n`);
    }
    console.log(`Run id: ${runId}`);
    console.log('='.repeat(64) + '\n');

    code = count('critical') > 0 ? 1 : 0;
  } catch (err) {
    console.error('\nDemo failed:', err.magnumHint || err.message);
    code = 2;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await closePool().catch(() => {});
  }

  process.exit(code);
}

main();
