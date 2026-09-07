#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { query, closePool, connectionString } = require('./client');
const { describeConnectionError, redact } = require('./connectionError');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  console.log(`Applying Magnum Opus schema to ${redact(connectionString())}`);
  await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  await query(schema);
  console.log('Schema applied successfully.');
  await closePool();
}

migrate().catch(async (err) => {
  // Phase 1.5 printed err.message here. On Windows a refused connection is
  // an AggregateError whose message is an empty string, so this printed a
  // blank line and told you nothing.
  console.error('\nMigration failed.\n');
  console.error(err.magnumHint || describeConnectionError(err, connectionString()));
  if (err.stack && !err.magnumHint) console.error('\n' + err.stack);
  try {
    await closePool();
  } catch (_) {}
  process.exit(1);
});
