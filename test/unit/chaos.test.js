'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ChaosPolicy } = require('../../src/chaos');
const { RandomStream } = require('../../src/random');

test('chaos is off unless explicitly enabled', () => {
  const p = new ChaosPolicy({});
  assert.strictEqual(p.select('POST', new RandomStream('a')), null);
});

test('reads are exempt by default — chaos on GETs is mostly noise', () => {
  const p = new ChaosPolicy({ enabled: true, rate: 1 });
  assert.strictEqual(p.select('GET', new RandomStream('a')), null);
  assert.ok(p.select('POST', new RandomStream('a')));
});

test('the fault rate is honoured', () => {
  const p = new ChaosPolicy({ enabled: true, rate: 0.25 });
  let faults = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) if (p.select('POST', new RandomStream(`s${i}`))) faults++;
  const rate = faults / n;
  assert.ok(rate > 0.22 && rate < 0.28, `expected ~0.25, got ${rate.toFixed(3)}`);
});

test('fault weights are normalised', () => {
  const p = new ChaosPolicy({
    enabled: true,
    rate: 1,
    faults: { delay: 3, reset: 1 }
  });
  let delays = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    if (p.select('POST', new RandomStream(`w${i}`)).type === 'delay') delays++;
  }
  const share = delays / n;
  assert.ok(share > 0.72 && share < 0.78, `expected ~0.75, got ${share.toFixed(3)}`);
});

test('chaos draws are deterministic for a given seed', () => {
  const p = new ChaosPolicy({ enabled: true, rate: 0.5 });
  const draw = () => {
    const rng = new RandomStream('fixed-seed');
    return [0, 1, 2, 3, 4].map(() => JSON.stringify(p.select('POST', rng)));
  };
  assert.deepStrictEqual(draw(), draw());
});

test('the stream advances by a constant amount regardless of which fault fires', () => {
  // Three draws every call, always — IF, WHICH, MAGNITUDE. An uneven cost
  // would advance the actor's stream differently depending on which fault
  // landed, so two runs with the same seed but different fault weights would
  // diverge in unrelated later decisions.
  const p = new ChaosPolicy({ enabled: true, rate: 0.5 });
  const rng = new RandomStream('align');
  for (let i = 0; i < 20; i++) {
    const before = rng.draws;
    p.select('POST', rng);
    assert.strictEqual(rng.draws - before, 3, 'every call must cost exactly three draws');
  }
});

test('changing fault weights does not desync later decisions', () => {
  const cost = (faults) => {
    const p = new ChaosPolicy({ enabled: true, rate: 0.5, faults });
    const rng = new RandomStream('same');
    for (let i = 0; i < 10; i++) p.select('POST', rng);
    return rng.draws;
  };
  assert.strictEqual(cost({ delay: 1 }), cost({ reset: 1, duplicate: 3 }));
});
