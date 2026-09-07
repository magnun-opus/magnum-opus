'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fingerprint, applyFingerprints } = require('../../src/analyst/fingerprint');
const { normalizeEndpoint, containsIdentifier } = require('../../src/analyst/detectors/isolation');

test('key order does not change the fingerprint', () => {
  assert.strictEqual(
    fingerprint({ detector: 'dup', action: 'POST /checkout' }),
    fingerprint({ action: 'POST /checkout', detector: 'dup' })
  );
});

test('the same defect fingerprints identically regardless of how many actors it hit', () => {
  const sig = { detector: 'duplicateWrites', action: 'POST /checkout', kind: 'not_idempotent' };
  const runA = [{ detector: 'duplicateWrites', signature: sig, summary: 'affected 14 actors' }];
  const runB = [{ detector: 'duplicateWrites', signature: sig, summary: 'affected 18 actors' }];
  applyFingerprints(runA);
  applyFingerprints(runB);
  assert.strictEqual(runA[0].fingerprint, runB[0].fingerprint);
});

test('different endpoints fingerprint differently', () => {
  assert.notStrictEqual(
    fingerprint({ detector: 'd', action: 'POST /checkout' }),
    fingerprint({ detector: 'd', action: 'POST /refund' })
  );
});

test('endpoint normalisation strips the query string', () => {
  // Session ids contain the run seed; without this the fingerprint would
  // change every run and every diff would report everything as new.
  assert.strictEqual(normalizeEndpoint('GET /orders?sessionId=sim-abc-3'), 'GET /orders');
  assert.strictEqual(
    normalizeEndpoint('GET /orders?sessionId=sim-abc-3'),
    normalizeEndpoint('GET /orders?sessionId=sim-xyz-9')
  );
});

test('identifier matching respects boundaries', () => {
  assert.strictEqual(containsIdentifier('{"s":"sim-seed-12"}', 'sim-seed-1'), false);
  assert.strictEqual(containsIdentifier('{"s":"sim-seed-1"}', 'sim-seed-1'), true);
  assert.strictEqual(containsIdentifier('{"a":"sim-seed-1","b":2}', 'sim-seed-1'), true);
});
