'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { Pool } = require('pg');
const { loadEnv } = require('../env');
const { describeConnectionError, redact } = require('../db/connectionError');

/**
 * Interactive setup.
 *
 * Hand-editing .env is where most first-run failures happen: a file saved as
 * .env.txt, a missing password, a port that doesn't match the server. This
 * asks, TESTS THE CONNECTION BEFORE WRITING ANYTHING, then writes the file
 * itself — so a saved file is always a working file.
 *
 * Uses Node's built-in readline/promises. No prompt library, no dependency.
 */

/** Password entry with echo suppressed — no dependency needed. */
async function askHidden(rl, question) {
  const onData = (char) => {
    if (['\n', '\r', '\u0004'].includes(char.toString('utf8'))) return;
    stdout.write('\u001b[2K\u001b[200D' + question + '*'.repeat(rl.line.length));
  };
  stdin.on('data', onData);
  try {
    const answer = await rl.question(question);
    stdout.write('\n');
    return answer;
  } finally {
    stdin.removeListener('data', onData);
  }
}

function buildUrl({ host, port, user, password, database }) {
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${port}/${database}`;
}

async function testConnection(url) {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: describeConnectionError(err, url) };
  } finally {
    await pool.end().catch(() => {});
  }
}

function quoteIdent(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

async function createDatabases(maintenanceUrl, names) {
  const pool = new Pool({ connectionString: maintenanceUrl });
  try {
    for (const name of names) {
      try {
        await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
        console.log(`  created  ${name}`);
      } catch (err) {
        if (err.code === '42P04') console.log(`  exists   ${name}`);
        else throw err;
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

function writeEnv(cwd, values) {
  const envPath = path.join(cwd, '.env');

  if (fs.existsSync(envPath)) {
    const backup = `${envPath}.backup-${Date.now()}`;
    fs.copyFileSync(envPath, backup);
    console.log(`  backed up existing .env to ${path.basename(backup)}`);
  }

  const content = `# Written by "magnum-opus setup" on ${new Date().toISOString()}
# Shell variables override anything set here.

MAGNUM_OPUS_DB_URL=${values.magnumUrl}
SAMPLE_APP_DB_URL=${values.sampleUrl}

# Where the simulation points. Overrides baseUrl in the config file.
MAGNUM_TARGET_URL=${values.targetUrl}

# Port for the bundled sample app.
PORT=${values.samplePort}
`;

  fs.writeFileSync(envPath, content);
  console.log(`  wrote    .env`);
  return envPath;
}

/** Clean up the .env.txt / .env.text trap while we are here. */
function removeStrayEnvFiles(cwd) {
  const strays = fs.readdirSync(cwd).filter((f) => /^\.env\.(txt|text)$/i.test(f));
  for (const stray of strays) {
    const from = path.join(cwd, stray);
    const to = path.join(cwd, `${stray}.superseded`);
    fs.renameSync(from, to);
    console.log(`  renamed  ${stray} -> ${stray}.superseded (it was never being read)`);
  }
}

async function setup({ cwd = process.cwd(), interactive = true, db = null, target = null } = {}) {
  loadEnv(cwd);

  // Prompts need a real terminal. Piped or redirected stdin makes
  // readline questions never resolve, and the process exits silently with
  // nothing written — which in CI looks like success. Fail loudly instead.
  if (interactive && !stdin.isTTY) {
    throw new Error(
      'Interactive setup needs a terminal, but stdin is not a TTY.\n' +
        'In a script or CI, use the non-interactive form:\n\n' +
        '  magnum-opus setup --db postgres://user:pass@host:5432/magnum_opus \\\n' +
        '                    --target http://localhost:3000'
    );
  }

  console.log('\nMagnum Opus — setup\n');

  let magnumUrl;
  let sampleUrl;
  let targetUrl = target || process.env.MAGNUM_TARGET_URL || 'http://localhost:3000';
  let samplePort = process.env.PORT || '4000';
  let maintenanceUrl;
  let magnumName = 'magnum_opus';
  let sampleName = 'magnum_opus_sample';

  if (!interactive) {
    magnumUrl = db || process.env.MAGNUM_OPUS_DB_URL;
    if (!magnumUrl) {
      throw new Error('Non-interactive setup needs --db <postgres url> or MAGNUM_OPUS_DB_URL');
    }
    const parsed = new URL(magnumUrl);
    magnumName = parsed.pathname.replace(/^\//, '') || 'magnum_opus';
    sampleUrl = process.env.SAMPLE_APP_DB_URL || magnumUrl.replace(/\/[^/]*$/, `/${sampleName}`);
    maintenanceUrl = magnumUrl.replace(/\/[^/]*$/, '/postgres');
  } else {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const ask = async (question, fallback) => {
        const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
        return answer || fallback || '';
      };

      console.log('Database connection\n');
      const host = await ask('  Host', '127.0.0.1');
      const port = await ask('  Port', '5432');
      const user = await ask('  User', 'postgres');
      const password = await askHidden(rl, '  Password (blank if none): ');

      magnumName = await ask('  Magnum Opus database name', 'magnum_opus');
      sampleName = await ask('  Sample app database name', 'magnum_opus_sample');

      const parts = { host, port, user, password };
      maintenanceUrl = buildUrl({ ...parts, database: 'postgres' });
      magnumUrl = buildUrl({ ...parts, database: magnumName });
      sampleUrl = buildUrl({ ...parts, database: sampleName });

      console.log(`\nTesting ${redact(maintenanceUrl)} ...`);
      const test = await testConnection(maintenanceUrl);
      if (!test.ok) {
        console.error(`\n${test.message}\n`);
        console.error('Nothing was written. Fix the above and run setup again.\n');
        return { ok: false };
      }
      console.log('  connection ok\n');

      console.log('Your application\n');
      targetUrl = await ask('  URL of the app to test', targetUrl);

      if (new URL(targetUrl).port === port) {
        console.log(
          `\n  Note: your app and Postgres are both on port ${port}.\n` +
            '  These can appear to coexist on Windows but the arrangement is fragile.\n'
        );
        samplePort = await ask('  Port for the bundled sample app', '4100');
        targetUrl = await ask('  URL of the app to test', `http://localhost:${samplePort}`);
      } else {
        samplePort = new URL(targetUrl).port || samplePort;
      }
    } finally {
      rl.close();
    }
  }

  console.log('\nCreating databases\n');
  await createDatabases(maintenanceUrl, [magnumName, sampleName]);

  console.log('\nWriting configuration\n');
  removeStrayEnvFiles(cwd);
  writeEnv(cwd, { magnumUrl, sampleUrl, targetUrl, samplePort });

  // Apply the schema through the freshly written connection details.
  process.env.MAGNUM_OPUS_DB_URL = magnumUrl;
  process.env.SAMPLE_APP_DB_URL = sampleUrl;

  console.log('\nApplying schema\n');
  const { query } = require('../db/client');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  await query(schema);
  console.log('  schema applied');

  console.log(`
Setup complete.

  database  ${redact(magnumUrl)}
  target    ${targetUrl}

Next:
  magnum-opus doctor      confirm the environment
  magnum-opus validate    check your endpoints answer
  magnum-opus run         run the simulation
`);

  return { ok: true, magnumUrl, sampleUrl, targetUrl };
}

module.exports = { setup, buildUrl, testConnection };
