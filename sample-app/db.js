'use strict';

const { Pool } = require('pg');
const path = require('path');
const { loadEnv } = require('../src/env');
const { describeConnectionError, redact } = require('../src/db/connectionError');

/**
 * The sample app's single database entry point.
 *
 * Previously seed.js and server.js each built their own Pool inline, which
 * meant neither loaded .env, neither rewrote `localhost` to 127.0.0.1, and
 * both reported failures with err.message — empty on Windows, where a
 * refused connection is an AggregateError. Fixing src/db/client.js did
 * nothing for these two files. One place now, shared with the engine.
 */
loadEnv(path.join(__dirname, '..'));

const DEFAULT_URL = 'postgres://postgres@127.0.0.1:5432/magnum_opus_sample';

function connectionString() {
  const url = process.env.SAMPLE_APP_DB_URL || DEFAULT_URL;
  if (process.env.MAGNUM_OPUS_ALLOW_LOCALHOST === '1') return url;
  return url.replace('@localhost:', '@127.0.0.1:').replace('//localhost:', '//127.0.0.1:');
}

function createPool() {
  const pool = new Pool({ connectionString: connectionString() });
  pool.on('error', (err) => console.error(describeConnectionError(err, connectionString())));
  return pool;
}

/** Consistent, non-empty failure output for both entry points. */
function reportAndExit(label, err) {
  console.error(`\n${label}\n`);
  console.error(describeConnectionError(err, connectionString()));
  process.exit(1);
}

module.exports = { createPool, connectionString, redact, reportAndExit, DEFAULT_URL };
