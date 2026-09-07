'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkTarget, classifyHost } = require('../../src/safety');

test('loopback and private hosts are allowed without ceremony', () => {
  for (const url of [
    'http://localhost:4000',
    'http://127.0.0.1:3000',
    'http://10.0.0.5',
    'http://192.168.1.20:8080',
    'http://172.16.4.4',
    'http://api.local'
  ]) {
    assert.ok(checkTarget(url, {}).allowed, `${url} should be allowed`);
  }
});

test('public hosts are refused by default', () => {
  const r = checkTarget('https://api.example.com', {});
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /Refusing to run against the non-local host/);
});

test('the allowlist alone is not enough', () => {
  const r = checkTarget('https://staging.example.com', {
    allowedHosts: ['staging.example.com']
  });
  assert.strictEqual(r.allowed, false, 'allowlist without acknowledgement must refuse');
  assert.match(r.reason, /--i-know-this-is-not-production/);
});

test('the flag alone is not enough', () => {
  const r = checkTarget('https://staging.example.com', { acknowledged: true });
  assert.strictEqual(r.allowed, false, 'acknowledgement without allowlist must refuse');
  assert.match(r.reason, /allowedHosts/);
});

test('both gestures together allow the run', () => {
  const r = checkTarget('https://staging.example.com', {
    allowedHosts: ['staging.example.com'],
    acknowledged: true
  });
  assert.strictEqual(r.allowed, true);
});

test('172.32 is public, not private (boundary of the RFC1918 block)', () => {
  assert.strictEqual(classifyHost('172.15.0.1'), 'public');
  assert.strictEqual(classifyHost('172.16.0.1'), 'private');
  assert.strictEqual(classifyHost('172.31.255.254'), 'private');
  assert.strictEqual(classifyHost('172.32.0.1'), 'public');
});

test('a malformed URL is refused rather than assumed safe', () => {
  assert.strictEqual(checkTarget('not-a-url', {}).allowed, false);
});
