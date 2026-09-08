'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPersonas, validatePersona, assertMixIsLoadable } = require('../../src/personas/loader');
const { init } = require('../../src/commands/init');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magnum-test-'));
}

test('falls back to the packaged personas when a project has none', () => {
  const r = loadPersonas({ cwd: tmpProject() });
  assert.strictEqual(r.isBuiltin, true);
  assert.ok(r.personas.impatient_customer);
});

test('a project directory takes precedence over the built-ins', () => {
  const cwd = tmpProject();
  const dir = path.join(cwd, 'magnum/personas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mine.json'),
    JSON.stringify({
      persona: 'my_flow',
      states: [
        { name: 'a', transitions: [{ to: 'b', condition: 'always' }] },
        { name: 'b', terminal: true, outcome_class: 'success' }
      ]
    })
  );
  const r = loadPersonas({ cwd });
  assert.strictEqual(r.isBuiltin, false);
  assert.ok(r.personas.my_flow);
  assert.strictEqual(r.personas.impatient_customer, undefined);
});

test('init scaffolds a loadable persona', () => {
  const cwd = tmpProject();
  init({ cwd });
  const config = JSON.parse(fs.readFileSync(path.join(cwd, 'magnum/config.json'), 'utf8'));
  const r = loadPersonas({ cwd });
  assert.ok(r.personas.example_customer, 'template persona should load');
  assertMixIsLoadable(config.personaMix, r.personas, r.source);
});

test('init never overwrites existing files', () => {
  const cwd = tmpProject();
  init({ cwd });
  const p = path.join(cwd, 'magnum/config.json');
  fs.writeFileSync(p, '{"mine":true}');
  const second = init({ cwd });
  assert.strictEqual(second.written.length, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { mine: true });
});

test('a transition to a nonexistent state is rejected at load time', () => {
  assert.throws(
    () =>
      validatePersona(
        {
          persona: 'broken',
          states: [
            { name: 'a', transitions: [{ to: 'ghost', condition: 'always' }] },
            { name: 'b', terminal: true }
          ]
        },
        'test'
      ),
    /unknown state "ghost"/
  );
});

test('a persona with no terminal state is rejected', () => {
  assert.throws(
    () =>
      validatePersona(
        { persona: 'loop', states: [{ name: 'a', transitions: [{ to: 'a', condition: 'always' }] }] },
        'test'
      ),
    /no terminal state/
  );
});

test('a config referencing a missing persona fails with a useful message', () => {
  assert.throws(
    () => assertMixIsLoadable({ ghost_user: 5 }, { real_user: {} }, '/some/dir'),
    /ghost_user[\s\S]*Available: real_user/
  );
});
