'use strict';

const test = require('node:test');
const assert = require('node:assert');
const trpc = require('../../src/protocols/trpc');
const { loadFromDir } = require('../../src/personas/loader');
const path = require('path');

const superjson = { protocol: 'trpc', trpc: { prefix: '/api/trpc', transformer: 'superjson' } };
const plain = { protocol: 'trpc', trpc: { prefix: '/api/trpc' } };
const scope = { vars: { amount: 5000 }, actor: { sessionId: 'u1' } };

test('a query encodes its input into the query string', () => {
  const r = trpc.buildRequest(plain, { procedure: 'banking.overview', type: 'query', input: { owner: 'u1' } }, scope);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.path, `/api/trpc/banking.overview?input=${encodeURIComponent('{"owner":"u1"}')}`);
});

test('a mutation sends its input as the body', () => {
  const r = trpc.buildRequest(plain, { procedure: 'banking.transfer', type: 'mutation', input: { amount: '{{vars.amount}}' } }, scope);
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.path, '/api/trpc/banking.transfer');
  assert.deepStrictEqual(r.body, { amount: 5000 });
});

test('a transformer wraps input on both verbs', () => {
  const q = trpc.buildRequest(superjson, { procedure: 'a.b', type: 'query', input: { x: 1 } }, scope);
  assert.match(decodeURIComponent(q.path), /\{"json":\{"x":1\}\}/);
  const m = trpc.buildRequest(superjson, { procedure: 'a.b', type: 'mutation', input: { x: 1 } }, scope);
  assert.deepStrictEqual(m.body, { json: { x: 1 } });
});

test('the logged action omits the query string so findings group by procedure', () => {
  // Otherwise every actor's distinct input would form its own group, and the
  // fingerprint would change every run, breaking diffs.
  const a = trpc.buildRequest(plain, { procedure: 'p.q', type: 'query', input: { owner: 'a' } }, scope);
  const b = trpc.buildRequest(plain, { procedure: 'p.q', type: 'query', input: { owner: 'b' } }, scope);
  assert.strictEqual(a.action, b.action);
  assert.strictEqual(a.action, 'GET /api/trpc/p.q');
  assert.notStrictEqual(a.path, b.path);
});

test('the JSON-RPC envelope is unwrapped', () => {
  assert.deepStrictEqual(trpc.unwrapResponse({ result: { data: { accounts: [1] } } }, null), { accounts: [1] });
});

test('a transformer wrapper is unwrapped too', () => {
  assert.deepStrictEqual(
    trpc.unwrapFor(superjson, { result: { data: { json: { accounts: [1] } } } }),
    { accounts: [1] }
  );
});

test('a plain REST response passes through untouched', () => {
  const body = { orders: [1, 2] };
  assert.deepStrictEqual(trpc.unwrapResponse(body, null), body);
});

test('an error response keeps its shape rather than becoming undefined', () => {
  const err = { error: { message: 'nope', code: 400 } };
  assert.deepStrictEqual(trpc.unwrapResponse(err, null), err);
});

test('interpolation happens inside procedure names and inputs', () => {
  const r = trpc.buildRequest(
    plain,
    { procedure: 'banking.transfer', type: 'mutation', input: { owner: '{{actor.sessionId}}' } },
    scope
  );
  assert.deepStrictEqual(r.body, { owner: 'u1' });
});

test('a spec is only treated as tRPC when the persona says so', () => {
  assert.strictEqual(trpc.isTrpcSpec({}, { action: 'GET /api/x' }), false);
  assert.strictEqual(trpc.isTrpcSpec({}, { event_type: 'trpc', procedure: 'a.b' }), true);
  assert.strictEqual(trpc.isTrpcSpec(plain, { procedure: 'a.b' }), true);
});

test('the banking-trpc pack loads and declares no REST paths', () => {
  const dir = path.join(__dirname, '../../src/templates/domains/banking-trpc/personas');
  const personas = loadFromDir(dir);
  assert.ok(personas.trpc_customer && personas.trpc_impatient);

  for (const persona of Object.values(personas)) {
    assert.strictEqual(persona.protocol, 'trpc');
    for (const state of persona.states) {
      const spec = state.on_enter;
      if (!spec || spec.event_type === 'wait') continue;
      assert.ok(spec.procedure, `${state.name} should name a procedure`);
      assert.ok(!spec.action, `${state.name} should not carry a REST action`);
    }
    // Invariants must read unwrapped paths — no envelope prefixes.
    for (const inv of persona.invariants || []) {
      const collection = inv.collection || inv.sum?.collection || '';
      assert.ok(!/result\.data|\.json\./.test(collection), `envelope leaked into "${collection}"`);
    }
  }
});
