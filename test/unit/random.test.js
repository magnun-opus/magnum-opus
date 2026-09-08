'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RandomStream, actorStream } = require('../../src/random');

test('identical seeds produce identical sequences', () => {
  const a = new RandomStream('seed-A');
  const b = new RandomStream('seed-A');
  const seqA = Array.from({ length: 100 }, () => a.float());
  const seqB = Array.from({ length: 100 }, () => b.float());
  assert.deepStrictEqual(seqA, seqB);
});

test('different seeds produce different sequences', () => {
  const a = new RandomStream('seed-A');
  const b = new RandomStream('seed-B');
  assert.notDeepStrictEqual(
    Array.from({ length: 20 }, () => a.float()),
    Array.from({ length: 20 }, () => b.float())
  );
});

test('draws stay within [0, 1)', () => {
  const s = new RandomStream('bounds');
  for (let i = 0; i < 10000; i++) {
    const v = s.float();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('actor streams are independent of interleaving order', () => {
  // Draw from actor 0, then 1, then 0 again.
  const forward = [];
  const s0 = actorStream('run-1', 0);
  const s1 = actorStream('run-1', 1);
  forward.push(s0.float(), s1.float(), s0.float());

  // Now interleave differently: 1, 0, 0.
  const reverse = [];
  const t0 = actorStream('run-1', 0);
  const t1 = actorStream('run-1', 1);
  const r1 = t1.float();
  reverse.push(t0.float(), r1, t0.float());

  // Each actor's own sequence is unchanged regardless of global order.
  assert.deepStrictEqual(forward, reverse);
});

test('int and range respect bounds', () => {
  const s = new RandomStream('bounds-2');
  for (let i = 0; i < 5000; i++) {
    const n = s.int(5, 10);
    assert.ok(Number.isInteger(n) && n >= 5 && n <= 10, `int out of range: ${n}`);
    const r = s.range(2, 3);
    assert.ok(r >= 2 && r < 3, `range out of bounds: ${r}`);
  }
});

test('exponential delays are non-negative and scale inversely with rate', () => {
  const fast = new RandomStream('exp');
  const slow = new RandomStream('exp');
  let fastTotal = 0;
  let slowTotal = 0;
  for (let i = 0; i < 2000; i++) {
    fastTotal += fast.exponentialDelayMs(50);
    slowTotal += slow.exponentialDelayMs(5);
  }
  assert.ok(fastTotal >= 0 && slowTotal >= 0);
  // Mean of an exponential is 1/lambda, so a 10x lower rate means ~10x waits.
  const ratio = slowTotal / fastTotal;
  assert.ok(ratio > 8 && ratio < 12, `expected ~10x, got ${ratio.toFixed(2)}`);
});
