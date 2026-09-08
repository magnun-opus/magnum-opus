'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateInvariants } = require('../../src/invariants/evaluate');
const { buildUrl } = require('../../src/commands/setup');

const persona = (invariants) => ({ invariants });
const countInv = [
  {
    name: 'one order per intent',
    type: 'count',
    collection: 'orders.orders',
    atMost: { intents: 'checkout' }
  }
];

test('an unreachable probe is SKIPPED, never reported as held', () => {
  // The false green: an unreachable probe resolved to zero records, and
  // "0 <= 1" passed. A run where nothing worked reported the invariant as
  // verified.
  const ctx = { probes: { orders: { __unreachable: true } }, intentCounts: { checkout: 1 } };
  const [r] = evaluateInvariants(persona(countInv), ctx);
  assert.strictEqual(r.ok, null, 'must not be a pass');
  assert.strictEqual(r.skipped, true);
  assert.match(r.message, /could not be reached/);
});

test('a probe that returns data but lacks the collection path is skipped', () => {
  // Also not evidence: the path is wrong, so zero records means nothing.
  const ctx = { probes: { orders: { somethingElse: [] } }, intentCounts: { checkout: 1 } };
  const [r] = evaluateInvariants(persona(countInv), ctx);
  assert.strictEqual(r.ok, null);
  assert.match(r.message, /check the path/);
});

test('a genuinely empty collection IS evaluated', () => {
  // The path exists and the app really returned nothing. That is evidence,
  // and must not be confused with the two cases above.
  const ctx = { probes: { orders: { orders: [] } }, intentCounts: { checkout: 1 } };
  const [r] = evaluateInvariants(persona(countInv), ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, undefined);
  assert.strictEqual(r.detail.actual, 0);
});

test('an undeclared probe is skipped with a useful reason', () => {
  const ctx = { probes: {}, intentCounts: { checkout: 1 } };
  const [r] = evaluateInvariants(persona(countInv), ctx);
  assert.strictEqual(r.ok, null);
  assert.match(r.message, /no probe named "orders"/);
});

test('unique and conservation skip on an unreachable probe too', () => {
  const ctx = { probes: { orders: { __unreachable: true } }, intentCounts: {} };
  const results = evaluateInvariants(
    persona([
      { name: 'u', type: 'unique', collection: 'orders.orders', field: 'id' },
      {
        name: 'c',
        type: 'conservation',
        sum: { collection: 'orders.orders', field: 'total' },
        equals: 100
      }
    ]),
    ctx
  );
  assert.strictEqual(results.length, 2);
  for (const r of results) assert.strictEqual(r.ok, null, `${r.name} must skip, not pass`);
});

test('setup builds a correct URL and encodes special characters in the password', () => {
  assert.strictEqual(
    buildUrl({ host: '127.0.0.1', port: '4000', user: 'postgres', password: 'p@ss:w/rd', database: 'magnum_opus' }),
    'postgres://postgres:p%40ss%3Aw%2Frd@127.0.0.1:4000/magnum_opus'
  );
});

test('setup omits the auth separator when there is no password', () => {
  assert.strictEqual(
    buildUrl({ host: 'localhost', port: '5432', user: 'claude', password: '', database: 'db' }),
    'postgres://claude@localhost:5432/db'
  );
});

test('doctor flags a .env saved with a stray extension', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  fs.writeFileSync(path.join(cwd, '.env.text'), 'MAGNUM_OPUS_DB_URL=x');

  const { doctor } = require('../../src/commands/doctor');
  const original = console.log;
  console.log = () => {};
  let results;
  try {
    ({ results } = await doctor({ cwd, config: null }));
  } finally {
    console.log = original;
  }

  const envCheck = results.find((r) => r.name === '.env file');
  assert.strictEqual(envCheck.status, 'fail');
  assert.match(envCheck.detail, /\.env\.text/);
  assert.match(envCheck.fix, /ren \.env\.text \.env/);
});

test('doctor flags the database and target sharing a port', async () => {
  const { doctor } = require('../../src/commands/doctor');
  process.env.MAGNUM_OPUS_DB_URL = 'postgres://postgres@127.0.0.1:4000/magnum_opus';

  const original = console.log;
  console.log = () => {};
  let results;
  try {
    ({ results } = await doctor({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'doctor2-')),
      config: { baseUrl: 'http://localhost:4000' }
    }));
  } finally {
    console.log = original;
    delete process.env.MAGNUM_OPUS_DB_URL;
  }

  const ports = results.find((r) => r.name === 'Ports');
  assert.strictEqual(ports.status, 'fail');
  assert.match(ports.detail, /both on 4000/);
});

test('loadPersonas tolerates an explicit null config', () => {
  // doctor on a first run passes config: null. A default parameter only
  // fills in `undefined`, so this crashed on the exact path meant to
  // diagnose a machine with nothing set up yet.
  const { loadPersonas } = require('../../src/personas/loader');
  const result = loadPersonas({ config: null, configPath: null, cwd: os.tmpdir() });
  assert.ok(result.personas, 'should fall back to built-in personas');
  assert.strictEqual(result.isBuiltin, true);
});

test('doctor reports no-config as a warning, not a failure', async () => {
  const { doctor } = require('../../src/commands/doctor');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor3-'));

  const original = console.log;
  console.log = () => {};
  let results;
  try {
    ({ results } = await doctor({ cwd, config: null, configPath: null }));
  } finally {
    console.log = original;
  }

  const personas = results.find((r) => r.name === 'Personas');
  assert.strictEqual(personas.status, 'warn', 'a first run has no config; that is expected');
  assert.doesNotMatch(String(personas.fix || ''), /Cannot read properties/);

  const config = results.find((r) => r.name === 'Config');
  assert.strictEqual(config.status, 'warn');
  assert.match(config.fix, /magnum-opus init/);
});

test('the bin path has no leading ./ — npm strips it and warns on publish', () => {
  const pkg = require('../../package.json');
  for (const [name, target] of Object.entries(pkg.bin)) {
    assert.ok(!target.startsWith('./'), `bin["${name}"] should be "${target.replace('./', '')}"`);
  }
});
