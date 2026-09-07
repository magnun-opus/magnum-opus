'use strict';

const { Pool } = require('pg');
const { loadEnv } = require('../env');
const { describeConnectionError } = require('./connectionError');

loadEnv();

const DEFAULT_URL = 'postgres://postgres@127.0.0.1:5432/magnum_opus';

/**
 * Normalise the host to avoid a Windows-specific trap: `localhost` resolves
 * to both ::1 and 127.0.0.1 there. Postgres typically listens on IPv4 only,
 * so Node tries ::1 first, fails, and surfaces an AggregateError with an
 * empty message. Pinning to 127.0.0.1 removes the ambiguity entirely.
 * Set MAGNUM_OPUS_ALLOW_LOCALHOST=1 if you genuinely need IPv6.
 */
function normalize(connectionString) {
  if (process.env.MAGNUM_OPUS_ALLOW_LOCALHOST === '1') return connectionString;
  return connectionString.replace('@localhost:', '@127.0.0.1:').replace('//localhost:', '//127.0.0.1:');
}

function connectionString() {
  return normalize(process.env.MAGNUM_OPUS_DB_URL || DEFAULT_URL);
}

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: connectionString() });
    // A pool-level error must not take the process down mid-run.
    pool.on('error', (err) => {
      console.error(describeConnectionError(err, connectionString()));
    });
  }
  return pool;
}

async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    // Connection-level failures get a readable explanation; SQL errors are
    // rethrown untouched so stack traces stay useful.
    if (err && (err.code === undefined || /^(ECONN|ENOTFOUND|ETIMEDOUT|28|3D)/.test(String(err.code)))) {
      err.magnumHint = describeConnectionError(err, connectionString());
    }
    throw err;
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, query, closePool, connectionString, normalize, DEFAULT_URL };
