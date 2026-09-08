'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveExtract, applyExtract, applySet } = require('../../src/personas/state');
const { evaluateInvariants } = require('../../src/invariants/evaluate');
const { RandomStream } = require('../../src/random');
const { loadFromDir } = require('../../src/personas/loader');
const fs = require('fs');
const path = require('path');

const body = {
  products: [
    { id: 'p1', priceMinor: 250000 },
    { id: 'p2', priceMinor: 480000 },
    { id: 'p3', priceMinor: 190000 }
  ]
};

test('a string path still works, so existing personas keep loading', () => {
  assert.strictEqual(resolveExtract('products.0.id', body), 'p1');
});

test('random picks differ between actors but replay identically', () => {
  const draw = (seed) =>
    resolveExtract({ path: 'products', pick: 'random', field: 'id' }, body, new RandomStream(seed));
  const across = ['a', 'b', 'c', 'd', 'e', 'f'].map(draw);
  assert.ok(new Set(across).size > 1, 'a population must not all choose the same item');
  assert.strictEqual(draw('a'), draw('a'), 'the same seed must replay the same choice');
});

test('two random picks from the same path agree on one element', () => {
  // The bug this prevents: an actor buying p2 at p1's price. Two rules drew
  // independently, producing a persona that was silently wrong rather than
  // loudly broken.
  const context = { vars: {}, actor: {} };
  applyExtract(
    {
      productId: { path: 'products', pick: 'random', field: 'id' },
      price: { path: 'products', pick: 'random', field: 'priceMinor' }
    },
    body,
    context,
    new RandomStream('coherence')
  );
  const chosen = body.products.find((p) => p.id === context.vars.productId);
  assert.strictEqual(context.vars.price, chosen.priceMinor);
});

test('first, last and index picks are exact', () => {
  const at = (pick) => resolveExtract({ path: 'products', pick, field: 'id' }, body);
  assert.strictEqual(at('first'), 'p1');
  assert.strictEqual(at('last'), 'p3');
  assert.strictEqual(at(1), 'p2');
});

test('an empty list extracts nothing rather than crashing', () => {
  assert.strictEqual(
    resolveExtract({ path: 'products', pick: 'random', field: 'id' }, { products: [] }, new RandomStream('x')),
    undefined
  );
});

test('set performs arithmetic on the actor own state', () => {
  const ctx = { vars: { budget: 1000, polls: 0 }, actor: {} };
  applySet({ budget: { subtract: 250 }, polls: { add: 1 }, tier: 'gold' }, ctx);
  assert.deepStrictEqual(ctx.vars, { budget: 750, polls: 1, tier: 'gold' });
});

test('set operands can reference other vars', () => {
  const ctx = { vars: { budget: 1000, price: 400 }, actor: {} };
  applySet({ budget: { subtract: '{{vars.price}}' } }, ctx);
  assert.strictEqual(ctx.vars.budget, 600);
});

test('set refuses to write NaN silently', () => {
  const ctx = { vars: { budget: 100 }, actor: {} };
  assert.throws(() => applySet({ budget: { add: 'not-a-number' } }, ctx), /produced NaN/);
});

test('bounds catches a single violating record', () => {
  // An aggregate would hide this: one negative balance among thousands is
  // still a broken system.
  const ctx = {
    probes: { acc: { accounts: [{ balance: 500 }, { balance: 900 }, { balance: -25 }] } },
    intentCounts: {}
  };
  const [r] = evaluateInvariants(
    { invariants: [{ name: 'balance >= 0', type: 'bounds', collection: 'acc.accounts', field: 'balance', min: 0 }] },
    ctx
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail.checked, 3);
  assert.strictEqual(r.detail.violations[0].value, -25);
});

test('bounds passes when every record is inside the range', () => {
  const ctx = { probes: { s: { items: [{ days: 2 }, { days: 5 }] } }, intentCounts: {} };
  const [r] = evaluateInvariants(
    { invariants: [{ name: 'sla', type: 'bounds', collection: 's.items', field: 'days', min: 0, max: 5 }] },
    ctx
  );
  assert.strictEqual(r.ok, true);
});

test('bounds needs at least one limit', () => {
  const ctx = { probes: { s: { items: [{ v: 1 }] } }, intentCounts: {} };
  const [r] = evaluateInvariants(
    { invariants: [{ name: 'x', type: 'bounds', collection: 's.items', field: 'v' }] },
    ctx
  );
  assert.strictEqual(r.ok, null);
  assert.match(r.message, /min.*max/);
});

test('match enforces presence and format', () => {
  const ctx = {
    probes: { s: { shipments: [{ t: 'SHIP-A1B2C' }, { t: 'nope' }, { t: null }] } },
    intentCounts: {}
  };
  const [r] = evaluateInvariants(
    {
      invariants: [
        { name: 'tracking', type: 'match', collection: 's.shipments', field: 't', pattern: '^SHIP-[A-Z0-9]{5}$' }
      ]
    },
    ctx
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail.violations.length, 2);
});

test('an invalid regex is skipped, not treated as a pass', () => {
  const ctx = { probes: { s: { items: [{ v: 'x' }] } }, intentCounts: {} };
  const [r] = evaluateInvariants(
    { invariants: [{ name: 'bad', type: 'match', collection: 's.items', field: 'v', pattern: '([' }] },
    ctx
  );
  assert.strictEqual(r.ok, null);
});

test('every shipped domain pack loads and validates', () => {
  const dir = path.join(__dirname, '../../src/templates/domains');
  const domains = fs.readdirSync(dir);
  assert.ok(domains.length >= 7, `expected at least 7 domain packs, found ${domains.length}`);

  for (const domain of domains) {
    const personas = loadFromDir(path.join(dir, domain, 'personas'));
    assert.ok(Object.keys(personas).length > 0, `${domain} has no personas`);

    const config = JSON.parse(fs.readFileSync(path.join(dir, domain, 'config.json'), 'utf8'));
    for (const name of Object.keys(config.personaMix)) {
      assert.ok(personas[name], `${domain}/config.json references missing persona "${name}"`);
    }

    // Every invariant must name a type the engine actually implements.
    const known = new Set(['count', 'unique', 'conservation', 'bounds', 'match']);
    for (const persona of Object.values(personas)) {
      for (const inv of persona.invariants || []) {
        assert.ok(known.has(inv.type), `${domain}: unknown invariant type "${inv.type}"`);
        assert.ok(inv.name, `${domain}: invariant missing a name`);
      }
      // Any invariant must have a probe supplying its collection.
      for (const inv of persona.invariants || []) {
        const probeName = String(inv.collection || inv.sum?.collection || '').split('.')[0];
        assert.ok(
          persona.probes && persona.probes[probeName],
          `${domain}/${persona.persona}: invariant "${inv.name}" reads probe "${probeName}" which is not declared`
        );
      }
    }
  }
});

test('match patterns interpolate against the actor own state', () => {
  // "^{{vars.userId}}$" is how a persona asserts every record belongs to the
  // actor who asked. Without interpolation this compared against the literal
  // template and reported a violation on a perfectly correct application.
  const ctx = {
    probes: { orders: { orders: [{ userId: 'user7' }, { userId: 'user7' }] } },
    intentCounts: {},
    vars: { userId: 'user7' },
    actor: {}
  };
  const [r] = evaluateInvariants(
    {
      invariants: [
        { name: 'own orders only', type: 'match', collection: 'orders.orders', field: 'userId', pattern: '^{{vars.userId}}$' }
      ]
    },
    ctx
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.detail.pattern, '^user7$');
});

test('match catches a record belonging to another actor', () => {
  const ctx = {
    probes: { orders: { orders: [{ userId: 'user7' }, { userId: 'user9' }] } },
    intentCounts: {},
    vars: { userId: 'user7' },
    actor: {}
  };
  const [r] = evaluateInvariants(
    {
      invariants: [
        { name: 'own orders only', type: 'match', collection: 'orders.orders', field: 'userId', pattern: '^{{vars.userId}}$' }
      ]
    },
    ctx
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail.violations[0].value, 'user9');
});

test('substituted values are regex-escaped so they cannot alter the pattern', () => {
  // A value like "a.c" must not match "abc" by accident.
  const ctx = {
    probes: { s: { items: [{ ref: 'abc' }] } },
    intentCounts: {},
    vars: { ref: 'a.c' },
    actor: {}
  };
  const [r] = evaluateInvariants(
    { invariants: [{ name: 'literal', type: 'match', collection: 's.items', field: 'ref', pattern: '^{{vars.ref}}$' }] },
    ctx
  );
  assert.strictEqual(r.ok, false, 'a dot in the value must be treated literally');
  assert.strictEqual(r.detail.pattern, '^a\\.c$');
});

test('bounds and match violations are critical, not warnings', () => {
  const { DETECTORS } = require('../../src/analyst/analyst');
  assert.ok(DETECTORS.invariantViolations, 'detector should be registered');
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/analyst/detectors/invariantViolations.js'),
    'utf8'
  );
  // Negative inventory or a leaked record is a correctness failure, not a hint.
  assert.match(src, /bounds:\s*'critical'/);
  assert.match(src, /match:\s*'critical'/);
});

test('init --domain refuses to leave a mismatched project', () => {
  // The trap: `init` then `init --domain banking` copied the banking
  // personas but left the previous config.json, so personaMix and the
  // invariants still pointed at the old domain. The run then failed with
  // errors about a collection the new personas never mention.
  const { init } = require('../../src/commands/init');
  const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'init-'));

  const quiet = console.log;
  console.log = () => {};
  try {
    init({ cwd });
    assert.throws(() => init({ cwd, domain: 'banking' }), (err) => {
      assert.strictEqual(err.code, 'MAGNUM_USER_ERROR');
      assert.match(err.message, /--force/);
      return true;
    });

    // --force resolves it, and the config really is the banking one.
    init({ cwd, domain: 'banking', force: true });
    const config = JSON.parse(fs.readFileSync(path.join(cwd, 'magnum/config.json'), 'utf8'));
    assert.strictEqual(config._domain, 'banking');
    assert.ok(config.personaMix.retail_customer, 'personaMix must be the banking one');
    assert.ok(!config.personaMix.example_customer, 'the old mix must be gone');
  } finally {
    console.log = quiet;
  }
});

test('re-running the same domain is not treated as a conflict', () => {
  const { init } = require('../../src/commands/init');
  const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'init2-'));
  const quiet = console.log;
  console.log = () => {};
  try {
    init({ cwd, domain: 'logistics' });
    init({ cwd, domain: 'logistics' }); // idempotent, must not throw
  } finally {
    console.log = quiet;
  }
});

test('an unknown domain names the available ones', () => {
  const { init } = require('../../src/commands/init');
  const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'init3-'));
  assert.throws(() => init({ cwd, domain: 'aerospace' }), /Available: .*banking/);
});
