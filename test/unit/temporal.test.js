'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { leastSquares } = require('../../src/analyst/detectors/temporalDegradation');
const { generatePersona } = require('../../src/commands/generate');
const { validatePersona } = require('../../src/personas/loader');

const fit = (ns, ls) => leastSquares(ns.map(Math.log), ls.map(Math.log));

test('a full table scan produces an exponent near 1', () => {
  const n = [100, 200, 400, 800, 1600];
  const r = fit(n, n.map((v) => v * 0.5));
  assert.ok(r.slope > 0.95 && r.slope < 1.05, `k=${r.slope}`);
  assert.ok(r.r2 > 0.99);
});

test('an indexed lookup produces an exponent near 0', () => {
  const n = [100, 200, 400, 800, 1600];
  const r = fit(n, [3.0, 3.1, 2.9, 3.05, 3.0]);
  assert.ok(Math.abs(r.slope) < 0.1, `k=${r.slope}`);
});

test('square-root growth is recognised as sub-linear', () => {
  const n = [100, 400, 1600, 6400];
  const r = fit(n, n.map(Math.sqrt));
  assert.ok(r.slope > 0.45 && r.slope < 0.55, `k=${r.slope}`);
});

test('R2 is low when points are scattered, so noise is not reported as a trend', () => {
  const n = [100, 200, 400, 800, 1600];
  const r = fit(n, [10, 3, 40, 5, 22]);
  assert.ok(r.r2 < 0.7, `R2=${r.r2} should fail the fit guard`);
});

test('a flat series yields no slope rather than dividing by zero', () => {
  const r = leastSquares([1, 1, 1], [2, 2, 2]);
  assert.strictEqual(r.slope, 0);
});

test('generated personas are valid and wire a probe from a POST/GET pair', () => {
  const spec = {
    info: { title: 'Test API' },
    paths: {
      '/widgets/{widgetId}': { get: {} },
      '/widgets': {
        get: {},
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { sessionId: { type: 'string' }, size: { type: 'integer' } }
                }
              }
            }
          }
        }
      }
    }
  };
  const persona = generatePersona(spec);
  validatePersona(persona, 'generated');

  assert.ok(persona.probes.widgets, 'a collection GET should become a probe');
  assert.strictEqual(persona.invariants.length, 1);

  const submit = persona.states.find((s) => s.name === 'submit');
  assert.strictEqual(submit.on_enter.intent, 'widgets');
  assert.strictEqual(submit.on_enter.body.sessionId, '{{actor.sessionId}}');
  assert.ok(persona.states.some((s) => s.terminal));
});

test('a spec with no write endpoint still generates something valid', () => {
  const persona = generatePersona({ info: { title: 'Read Only' }, paths: { '/x/{id}': { get: {} } } });
  validatePersona(persona, 'generated');
  assert.ok(!persona.probes);
});
