'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env loader — no dependency, works on every Node 18+.
 *
 * Phase 1.5 shipped a .env.example that nothing ever read: there was no
 * dotenv dependency and no --env-file flag, so copying it did nothing.
 * This is called once from db/client.js, which every entry point requires.
 *
 * Existing environment variables always win, so `set VAR=...` in the shell
 * overrides the file rather than the other way round.
 */
let loaded = false;

function loadEnv(cwd = process.cwd()) {
  if (loaded) return;
  loaded = true;

  const envPath = path.resolve(cwd, '.env');
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = { loadEnv };
