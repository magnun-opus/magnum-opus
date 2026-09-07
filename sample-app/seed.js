'use strict';

const fs = require('fs');
const path = require('path');
const { createPool, connectionString, redact, reportAndExit } = require('./db');

async function seed() {
  const pool = createPool();
  console.log(`Seeding sample app database at ${redact(connectionString())}`);
  const sql = fs.readFileSync(path.join(__dirname, 'db.sql'), 'utf8');
  await pool.query(sql);
  console.log('Sample app database seeded.');
  await pool.end();
}

seed().catch((err) => reportAndExit('Seed failed.', err));
