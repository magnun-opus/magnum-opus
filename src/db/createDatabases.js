#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const { loadEnv } = require('../env');
const { normalize, DEFAULT_URL } = require('./client');
const { describeConnectionError, redact } = require('./connectionError');

loadEnv();

/**
 * Creates both databases over a normal SQL connection.
 *
 * This exists so setup never depends on the `createdb` binary being on your
 * PATH — which it is not, by default, on a standard Windows PostgreSQL
 * install. Connects to the `postgres` maintenance database using the same
 * credentials as your app connection string.
 */
function maintenanceUrl(appUrl) {
  const u = new URL(appUrl);
  const target = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  return { maintenance: u.toString(), target };
}

/** Quote an identifier safely: CREATE DATABASE takes no bind parameters. */
function quoteIdent(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

async function createIfMissing(pool, name) {
  try {
    await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
    console.log(`  created  ${name}`);
  } catch (err) {
    if (err.code === '42P04') {
      console.log(`  exists   ${name}`);
      return;
    }
    throw err;
  }
}

async function main() {
  const appUrl = normalize(process.env.MAGNUM_OPUS_DB_URL || DEFAULT_URL);
  const sampleUrl = normalize(
    process.env.SAMPLE_APP_DB_URL || appUrl.replace(/\/[^/]*$/, '/magnum_opus_sample')
  );

  const { maintenance, target } = maintenanceUrl(appUrl);
  const sampleTarget = new URL(sampleUrl).pathname.replace(/^\//, '');

  console.log(`Connecting to ${redact(maintenance)}`);
  const pool = new Pool({ connectionString: maintenance });

  try {
    await createIfMissing(pool, target);
    await createIfMissing(pool, sampleTarget);
    console.log('\nDatabases ready. Next: npm run migrate');
  } catch (err) {
    console.error('\n' + describeConnectionError(err, maintenance));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { maintenanceUrl, main };
