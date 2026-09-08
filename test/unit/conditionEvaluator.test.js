'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveTransition, CONDITIONS } = require('../../src/personas/conditionEvaluator');
const { RandomStream } = require('../../src/random');

const successCtx = { lastClientOutcome: 'success' };
const timeoutCtx = { lastClientOutcome: 'timeout' };

test('returns null when nothing matches', () => {
  assert.strictEqual(
    resolveTransition([{ to: 'x', condition: 'on_error' }], successCtx),
    null
  );
});

test('a specific condition beats always (Phase 1 rolled dice between them)', () => {
  const transitions = [
    { to: 'fallback', condition: 'always' },
    { to: 'specific', condition: 'on_success' }
  ];
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(resolveTransition(transitions, successCtx, Math.random).to, 'specific');
  }
});

test('always is used when no specific condition matches', () => {
  const transitions = [
    { to: 'fallback', condition: 'always' },
    { to: 'specific', condition: 'on_error' }
  ];
  assert.strictEqual(resolveTransition(transitions, successCtx).to, 'fallback');
});

test('probability weights are normalised, not assumed to sum to 1', () => {
  // Weights 3 and 1 -> 75/25, even though they sum to 4.
  const transitions = [
    { to: 'heavy', condition: 'on_timeout', probability: 3 },
    { to: 'light', condition: 'on_timeout', probability: 1 }
  ];
  const rng = new RandomStream('weights');
  let heavy = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    if (resolveTransition(transitions, timeoutCtx, () => rng.float()).to === 'heavy') heavy++;
  }
  const share = heavy / N;
  assert.ok(share > 0.73 && share < 0.77, `expected ~0.75, got ${share.toFixed(3)}`);
});

test('sub-unit probabilities no longer over-select the last branch', () => {
  // Phase 1 bug: {0.5, 0.1} left 0.4 of the roll space falling through to
  // the final candidate, giving it 0.5 instead of its declared share.
  const transitions = [
    { to: 'a', condition: 'on_timeout', probability: 0.5 },
    { to: 'b', condition: 'on_timeout', probability: 0.1 }
  ];
  const rng = new RandomStream('subunit');
  let a = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    if (resolveTransition(transitions, timeoutCtx, () => rng.float()).to === 'a') a++;
  }
  const share = a / N; // normalised: 0.5 / 0.6 = 0.833
  assert.ok(share > 0.81 && share < 0.855, `expected ~0.833, got ${share.toFixed(3)}`);
});

test('90/10 retry-vs-abandon split holds', () => {
  const transitions = [
    { to: 'retry', condition: 'no_response_after_wait', probability: 0.9 },
    { to: 'abandon', condition: 'no_response_after_wait', probability: 0.1 }
  ];
  const rng = new RandomStream('retry-split');
  const ctx = { responseArrivedDuringWait: false };
  let retry = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    if (resolveTransition(transitions, ctx, () => rng.float()).to === 'retry') retry++;
  }
  const share = retry / N;
  assert.ok(share > 0.885 && share < 0.915, `expected ~0.9, got ${share.toFixed(3)}`);
});

test('unknown conditions fail loudly', () => {
  assert.throws(
    () => resolveTransition([{ to: 'x', condition: 'made_up' }], successCtx),
    /Unknown condition: made_up/
  );
});

test('wait conditions are genuinely reachable in both directions', () => {
  assert.strictEqual(CONDITIONS.response_received_within_wait({ responseArrivedDuringWait: true }), true);
  assert.strictEqual(CONDITIONS.no_response_after_wait({ responseArrivedDuringWait: false }), true);
});
