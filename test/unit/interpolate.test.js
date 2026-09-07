'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { interpolate, getPath } = require('../../src/interpolate');

const scope = {
  vars: { productId: 3, quantity: 2, name: 'hub' },
  actor: { sessionId: 'sim-seed-7' }
};

test('an exact placeholder preserves the value type', () => {
  assert.strictEqual(interpolate('{{vars.productId}}', scope), 3);
  assert.strictEqual(typeof interpolate('{{vars.productId}}', scope), 'number');
});

test('an embedded placeholder stringifies', () => {
  assert.strictEqual(interpolate('GET /products/{{vars.productId}}', scope), 'GET /products/3');
});

test('objects and arrays resolve recursively', () => {
  const body = {
    sessionId: '{{actor.sessionId}}',
    items: [{ productId: '{{vars.productId}}', qty: '{{vars.quantity}}' }]
  };
  assert.deepStrictEqual(interpolate(body, scope), {
    sessionId: 'sim-seed-7',
    items: [{ productId: 3, qty: 2 }]
  });
});

test('unresolved references throw rather than sending "undefined"', () => {
  assert.throws(() => interpolate('{{vars.missing}}', scope), /Unresolved template reference/);
  assert.throws(() => interpolate('/x/{{actor.missing}}', scope), /Unresolved template reference/);
});

test('getPath walks nested objects and array indexes', () => {
  assert.strictEqual(getPath({ a: { b: [{ c: 9 }] } }, 'a.b[0].c'), 9);
  assert.strictEqual(getPath({ a: 1 }, 'a.b.c'), undefined);
  assert.strictEqual(getPath(null, 'a'), undefined);
});

test('non-template values pass through untouched', () => {
  assert.strictEqual(interpolate(42, scope), 42);
  assert.strictEqual(interpolate(null, scope), null);
  assert.strictEqual(interpolate('plain', scope), 'plain');
});
