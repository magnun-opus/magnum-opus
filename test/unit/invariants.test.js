'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateInvariants } = require('../../src/invariants/evaluate');

const duplicated = {
  probes: { orders: { orders: [{ id: 7, total_cents: 2499 }, { id: 8, total_cents: 2499 }] } },
  intentCounts: { checkout: 1 }
};
const clean = {
  probes: { orders: { orders: [{ id: 7, total_cents: 2499 }] } },
  intentCounts: { checkout: 1 }
};

const persona = (invariants) => ({ invariants });

test('count catches more records than intents', () => {
  const [r] = evaluateInvariants(
    persona([{ name: 'one per intent', type: 'count', collection: 'orders.orders', atMost: { intents: 'checkout' } }]),
    duplicated
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail.actual, 2);
  assert.strictEqual(r.detail.expected, 1);
});

test('count holds on a correct application', () => {
  const [r] = evaluateInvariants(
    persona([{ name: 'one per intent', type: 'count', collection: 'orders.orders', atMost: { intents: 'checkout' } }]),
    clean
  );
  assert.strictEqual(r.ok, true);
});

test('unique catches repeated field values', () => {
  const dupIds = { probes: { orders: { orders: [{ id: 7 }, { id: 7 }] } }, intentCounts: {} };
  const [r] = evaluateInvariants(
    persona([{ name: 'ids distinct', type: 'unique', collection: 'orders.orders', field: 'id' }]),
    dupIds
  );
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.detail.duplicates, [7]);
});

test('conservation compares a sum against an expected total', () => {
  const ctx = {
    probes: { ledger: { entries: [{ amount: 300 }, { amount: 700 }], balance: 1000 } },
    intentCounts: {}
  };
  const inv = {
    name: 'ledger balances',
    type: 'conservation',
    sum: { collection: 'ledger.entries', field: 'amount' },
    equals: { path: 'ledger.balance' }
  };
  assert.strictEqual(evaluateInvariants(persona([inv]), ctx)[0].ok, true);

  ctx.probes.ledger.balance = 999;
  const bad = evaluateInvariants(persona([inv]), ctx)[0];
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.detail.drift, 1);
});

test('tolerance permits bounded drift', () => {
  const ctx = {
    probes: { ledger: { entries: [{ amount: 1001 }], balance: 1000 } },
    intentCounts: {}
  };
  const inv = {
    name: 'ledger balances',
    type: 'conservation',
    sum: { collection: 'ledger.entries', field: 'amount' },
    equals: { path: 'ledger.balance' },
    tolerance: 1
  };
  assert.strictEqual(evaluateInvariants(persona([inv]), ctx)[0].ok, true);
});

test('an unknown invariant type is skipped, not silently passed', () => {
  const [r] = evaluateInvariants(persona([{ name: 'x', type: 'telepathy' }]), clean);
  assert.strictEqual(r.ok, null);
  assert.strictEqual(r.skipped, true);
});

test('a missing collection is SKIPPED, not passed', () => {
  // Previously this returned ok:true because zero records satisfies
  // "at most 1". That is a vacuous truth: no probe means no evidence, and
  // reporting it as a pass is a false green.
  const [r] = evaluateInvariants(
    persona([{ name: 'c', type: 'count', collection: 'nope.nothing', atMost: 1 }]),
    clean
  );
  assert.strictEqual(r.ok, null);
  assert.strictEqual(r.skipped, true);
});
