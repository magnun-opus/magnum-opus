'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../env');
const { connectionString, normalize, DEFAULT_URL } = require('../db/client');
const { describeConnectionError, redact } = require('../db/connectionError');
const { loadPersonas, assertMixIsLoadable } = require('../personas/loader');
const { classifyHost } = require('../safety');

/**
 * Environment preflight.
 *
 * Ordered so the FIRST failure is the actual cause. Checking the target
 * before the database would report "target unreachable" when the real
 * problem is that nothing is configured yet, which sends people down the
 * wrong path — the most expensive kind of error message.
 *
 * Every check returns pass / warn / fail plus a concrete next action. A
 * diagnostic that tells you something is wrong without telling you what to
 * do is only half a diagnostic.
 */

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

const ICON = { pass: '  ok  ', warn: ' warn ', fail: ' FAIL ' };

function check(name, status, detail, fix) {
  return { name, status, detail, fix };
}

/** Node 18+ is required for the built-in fetch and crypto.randomUUID. */
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return check('Node.js', PASS, `v${process.versions.node}`);
  }
  return check(
    'Node.js',
    FAIL,
    `v${process.versions.node} is too old`,
    'Magnum Opus needs Node 18 or newer (it uses the built-in fetch). Install from https://nodejs.org'
  );
}

/**
 * The .env trap that cost real time: Notepad appends an extension unless you
 * set "Save as type" to All Files, so you end up with .env.txt or .env.text
 * and every command silently falls back to defaults.
 */
function checkEnvFile(cwd) {
  const envPath = path.join(cwd, '.env');
  if (fs.existsSync(envPath)) {
    return check('.env file', PASS, path.relative(cwd, envPath) || '.env');
  }

  const strays = fs
    .readdirSync(cwd)
    .filter((f) => /^\.env\.(txt|text|bak|save)$/i.test(f));

  if (strays.length > 0) {
    return check(
      '.env file',
      FAIL,
      `found ${strays.join(', ')} but no .env`,
      `Rename it:  ren ${strays[0]} .env` +
        `\n           (Notepad appends an extension unless "Save as type" is set to All Files)`
    );
  }

  if (fs.existsSync(path.join(cwd, '.env.example'))) {
    return check(
      '.env file',
      WARN,
      'not found — using built-in defaults',
      'Run "magnum-opus setup" to create one, or copy .env.example to .env'
    );
  }

  return check('.env file', WARN, 'not found — using built-in defaults');
}

async function checkDatabase(label, url) {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await pool.query('SELECT 1');
    return { result: check(label, PASS, redact(url)), reachable: true };
  } catch (err) {
    return {
      result: check(label, FAIL, redact(url), describeConnectionError(err, url)),
      reachable: false
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Are the tables actually there, or has migrate never run? */
async function checkSchema(url) {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('simulation_runs','actors','events','findings')`
    );
    const found = rows.map((r) => r.table_name);
    const missing = ['simulation_runs', 'actors', 'events', 'findings'].filter(
      (t) => !found.includes(t)
    );
    if (missing.length === 0) return check('Schema', PASS, 'all tables present');
    return check(
      'Schema',
      FAIL,
      `missing: ${missing.join(', ')}`,
      'Run "magnum-opus setup" (or "npm run migrate") to apply the schema'
    );
  } catch (err) {
    return check('Schema', FAIL, 'could not inspect', err.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Is the target answering? Any HTTP status counts as reachable — a 404 on
 * the root path is normal and not a problem (the sample app has no route at
 * "/"). What matters is whether something is listening at all.
 */
async function checkTarget(baseUrl) {
  if (!baseUrl) {
    return check('Target', WARN, 'no baseUrl configured', 'Set baseUrl in your config or MAGNUM_TARGET_URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(baseUrl, { signal: controller.signal });
    return check('Target', PASS, `${baseUrl} responded (HTTP ${res.status})`);
  } catch (err) {
    return check(
      'Target',
      FAIL,
      `${baseUrl} is not responding`,
      'Start your application, then check the port matches baseUrl.\n' +
        'A simulation against a dead target produces findings about nothing.'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The collision that silently half-worked: Postgres on IPv4 127.0.0.1:4000
 * and the app on IPv6 [::]:4000. Windows permits that split, so both appear
 * to start and the failure surfaces later as something unrelated.
 */
function checkPortCollision(dbUrl, baseUrl) {
  try {
    const dbPort = new URL(dbUrl).port || '5432';
    const appPort = new URL(baseUrl).port || '80';
    if (dbPort !== appPort) return check('Ports', PASS, `database ${dbPort}, target ${appPort}`);
    return check(
      'Ports',
      FAIL,
      `database and target are both on ${dbPort}`,
      'Move the application to another port and update baseUrl (or MAGNUM_TARGET_URL).\n' +
        'These can appear to coexist on Windows — Postgres binds IPv4 and Node binds IPv6 —\n' +
        'but the arrangement is fragile and fails unpredictably.'
    );
  } catch (_) {
    return check('Ports', WARN, 'could not compare ports');
  }
}

/** Whether a config file was found at all — a first run has none, and that
 *  is expected rather than broken. */
function checkConfig(config, configPath, cwd) {
  if (config && configPath) {
    return check('Config', PASS, path.relative(cwd, configPath) || configPath);
  }
  return check(
    'Config',
    WARN,
    'no config file found',
    'Run "magnum-opus init" to scaffold magnum/config.json, then point baseUrl at your app.'
  );
}

function checkPersonas(config, configPath) {
  if (!config) {
    return check(
      'Personas',
      WARN,
      'not checked — no config file yet',
      'Run "magnum-opus init", then "magnum-opus generate --spec openapi.json".'
    );
  }
  try {
    const { personas, source, isBuiltin } = loadPersonas({ config, configPath });
    if (config && config.personaMix) assertMixIsLoadable(config.personaMix, personas, source);
    const names = Object.keys(personas).join(', ');
    return check(
      'Personas',
      isBuiltin ? WARN : PASS,
      `${names}${isBuiltin ? '  (built-in demo personas)' : ''}`,
      isBuiltin
        ? 'These describe the bundled sample app, not yours.\n' +
          'Run "magnum-opus init" or "magnum-opus generate --spec openapi.json".'
        : undefined
    );
  } catch (err) {
    return check('Personas', FAIL, 'could not load', err.message);
  }
}

function checkSafety(config) {
  if (!config || !config.baseUrl) return null;
  try {
    const classification = classifyHost(new URL(config.baseUrl).hostname);
    if (classification === 'public') {
      return check(
        'Target safety',
        WARN,
        'the target is a public host',
        'Runs against non-local hosts are refused unless the host is in "allowedHosts"\n' +
          'AND --i-know-this-is-not-production is passed. This tool abandons requests\n' +
          'mid-flight and retries write intents.'
      );
    }
    return check('Target safety', PASS, `${classification} target`);
  } catch (_) {
    return null;
  }
}

async function doctor({ config = null, configPath = null, cwd = process.cwd() } = {}) {
  loadEnv(cwd);

  const results = [];
  results.push(checkNode());
  results.push(checkEnvFile(cwd));

  const magnumUrl = connectionString();
  const sampleUrl = normalize(
    process.env.SAMPLE_APP_DB_URL || magnumUrl.replace(/\/[^/]*$/, '/magnum_opus_sample')
  );

  const magnumDb = await checkDatabase('Database', magnumUrl);
  results.push(magnumDb.result);

  if (magnumDb.reachable) {
    results.push(await checkSchema(magnumUrl));
  } else {
    results.push(check('Schema', WARN, 'skipped — database unreachable'));
  }

  results.push(checkConfig(config, configPath, cwd));

  const baseUrl = (config && config.baseUrl) || process.env.MAGNUM_TARGET_URL || null;
  results.push(await checkTarget(baseUrl));
  if (baseUrl) results.push(checkPortCollision(magnumUrl, baseUrl));

  results.push(checkPersonas(config, configPath));
  const safety = checkSafety(config);
  if (safety) results.push(safety);

  print(results);

  const failures = results.filter((r) => r.status === FAIL);
  return { results, ok: failures.length === 0, failures: failures.length };
}

function print(results) {
  console.log('\nMagnum Opus — environment check\n');
  for (const r of results) {
    console.log(`[${ICON[r.status]}] ${r.name.padEnd(14)} ${r.detail}`);
    if (r.fix) {
      for (const line of String(r.fix).split('\n')) console.log(`               ${line}`);
    }
  }

  const failed = results.filter((r) => r.status === FAIL).length;
  const warned = results.filter((r) => r.status === WARN).length;
  console.log('');
  if (failed > 0) {
    console.log(`${failed} problem(s) must be fixed before a run will produce meaningful results.\n`);
  } else if (warned > 0) {
    console.log(`Ready to run, with ${warned} thing(s) worth reviewing above.\n`);
  } else {
    console.log('Everything checks out. Next: magnum-opus validate\n');
  }
}

module.exports = { doctor };
