'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Generates persona drafts from an OpenAPI document.
 *
 * Deliberately deterministic, not AI: it applies stated heuristics you can
 * read and predict, and it produces a DRAFT with TODO markers rather than
 * pretending to understand your domain. What it saves is the mechanical part
 * — transcribing paths, methods, parameters and body fields — not the part
 * that requires knowing what your application means.
 *
 * Heuristics:
 *   GET  /things            collection read      -> a browse state
 *   GET  /things/{id}       item read            -> a browse state, and a
 *                                                   candidate read-back probe
 *   POST /things            creation             -> a write state with an
 *                                                   "intent" and a retry path
 *   PUT/PATCH/DELETE        mutation             -> a write state with intent
 *
 * A resource with both POST /things and GET /things gets a probe plus a
 * count invariant, because that pair is exactly what verifies idempotency.
 */
function loadSpec(specPath) {
  const text = fs.readFileSync(specPath, 'utf8');
  if (/\.ya?ml$/i.test(specPath)) {
    throw new Error(
      'YAML specs are not supported (Magnum Opus has no YAML dependency).\n' +
        'Convert it first:  npx js-yaml openapi.yaml > openapi.json'
    );
  }
  return JSON.parse(text);
}

function resourceOf(routePath) {
  const segments = routePath.split('/').filter(Boolean);
  const named = segments.filter((s) => !s.startsWith('{'));
  return named[named.length - 1] || 'root';
}

/** Build an example request body from a schema, one level deep. */
function exampleBody(schema, seen = 0) {
  if (!schema || seen > 2) return {};
  const resolved = schema.schema || schema;
  if (resolved.type !== 'object' || !resolved.properties) return {};

  const body = {};
  for (const [name, prop] of Object.entries(resolved.properties)) {
    if (/session|user|customer|account/i.test(name)) body[name] = '{{actor.sessionId}}';
    else if (prop.example !== undefined) body[name] = prop.example;
    else if (prop.type === 'integer' || prop.type === 'number') body[name] = 1;
    else if (prop.type === 'boolean') body[name] = true;
    else if (prop.type === 'array') body[name] = [];
    else body[name] = `TODO_${name}`;
  }
  return body;
}

function requestBodyFor(operation) {
  const content = operation?.requestBody?.content;
  if (!content) return undefined;
  const json = content['application/json'];
  if (!json) return undefined;
  return exampleBody(json.schema);
}

function pathWithParams(routePath) {
  // /orders/{orderId} -> /orders/{{vars.orderId}}
  return routePath.replace(/\{([^}]+)\}/g, (_, name) => `{{vars.${name}}}`);
}

function collectParams(routePath) {
  return [...routePath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function generatePersona(spec, options = {}) {
  const paths = spec.paths || {};
  const writes = [];
  const reads = [];
  const collections = new Map();

  for (const [routePath, item] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = item[method];
      if (!operation) continue;

      const entry = {
        method: method.toUpperCase(),
        path: routePath,
        operation,
        resource: resourceOf(routePath),
        params: collectParams(routePath)
      };

      if (method === 'get') {
        reads.push(entry);
        if (entry.params.length === 0) collections.set(entry.resource, entry);
      } else {
        writes.push(entry);
      }
    }
  }

  const primaryWrite = writes.find((w) => w.method === 'POST') || writes[0];
  const browse = reads.filter((r) => r.params.length > 0).slice(0, 1);
  const states = [];
  const variables = {};

  for (const r of browse) {
    for (const p of r.params) variables[p] = { choice: [1, 2, 3] };
  }

  let entryState;

  if (browse.length > 0) {
    entryState = 'browse';
    states.push({
      name: 'browse',
      on_enter: {
        event_type: 'http_request',
        action: `GET ${pathWithParams(browse[0].path)}`
      },
      think_ms: [200, 600],
      transitions: [
        { to: primaryWrite ? 'submit' : 'done', condition: 'on_success' },
        { to: 'give_up', condition: 'on_error' },
        { to: 'give_up', condition: 'on_timeout' }
      ]
    });
  }

  if (primaryWrite) {
    if (!entryState) entryState = 'submit';
    const body = requestBodyFor(primaryWrite.operation) || { sessionId: '{{actor.sessionId}}' };

    states.push({
      name: 'submit',
      on_enter: {
        event_type: 'http_request',
        action: `${primaryWrite.method} ${pathWithParams(primaryWrite.path)}`,
        intent: primaryWrite.resource,
        body,
        extract: { createdId: 'id' }
      },
      transitions: [
        { to: 'done', condition: 'on_success' },
        { to: 'wait', condition: 'on_timeout' },
        { to: 'give_up', condition: 'on_error' }
      ]
    });

    states.push({
      name: 'wait',
      on_enter: { event_type: 'wait', duration_ms: 800 },
      transitions: [
        { to: 'done', condition: 'response_received_within_wait' },
        { to: 'retry', condition: 'no_response_after_wait', probability: 0.85 },
        { to: 'give_up', condition: 'no_response_after_wait', probability: 0.15 }
      ]
    });

    states.push({
      name: 'retry',
      on_enter: {
        event_type: 'http_request',
        action: `${primaryWrite.method} ${pathWithParams(primaryWrite.path)}`,
        intent: primaryWrite.resource,
        tags: ['retry'],
        body
      },
      transitions: [
        { to: 'done', condition: 'on_success' },
        { to: 'give_up', condition: 'on_timeout' },
        { to: 'give_up', condition: 'on_error' }
      ]
    });
  }

  states.push({ name: 'done', terminal: true, outcome_class: 'success' });
  states.push({ name: 'give_up', terminal: true, outcome_class: 'abandon' });

  const persona = {
    persona: options.name || `${(spec.info?.title || 'api').toLowerCase().replace(/\W+/g, '_')}_user`,
    _generated: {
      from: options.source || 'openapi',
      note:
        'DRAFT — review every field. Bodies are inferred from the schema and ' +
        'any TODO_ value must be replaced. Invariants encode assumptions the ' +
        'spec cannot express.'
    },
    patience_ms: 1500,
    variables
  };

  // A create endpoint paired with a collection read is exactly the shape that
  // verifies idempotency, so wire the probe and invariant automatically.
  const matchingCollection = primaryWrite && collections.get(primaryWrite.resource);
  if (matchingCollection) {
    persona.probes = {
      [primaryWrite.resource]: {
        action: `GET ${matchingCollection.path}?sessionId={{actor.sessionId}}`
      }
    };
    persona.invariants = [
      {
        name: `one ${primaryWrite.resource} per ${primaryWrite.resource} intent`,
        type: 'count',
        collection: `${primaryWrite.resource}.${primaryWrite.resource}`,
        atMost: { intents: primaryWrite.resource }
      }
    ];
  }

  persona.states = states;

  // The engine walks states in order from the first, so the entry state leads.
  if (entryState && persona.states[0].name !== entryState) {
    const idx = persona.states.findIndex((s) => s.name === entryState);
    if (idx > 0) persona.states.unshift(persona.states.splice(idx, 1)[0]);
  }

  return persona;
}

function generate({ specPath, outDir = 'magnum/personas', cwd = process.cwd(), name } = {}) {
  const spec = loadSpec(path.resolve(cwd, specPath));
  const persona = generatePersona(spec, { name, source: specPath });

  const dir = path.resolve(cwd, outDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${persona.persona}.json`);
  fs.writeFileSync(file, JSON.stringify(persona, null, 2));

  const todos = JSON.stringify(persona).match(/TODO_\w+/g) || [];

  console.log(`\nGenerated ${path.relative(cwd, file)}\n`);
  console.log(`  persona:    ${persona.persona}`);
  console.log(`  states:     ${persona.states.map((s) => s.name).join(' -> ')}`);
  console.log(`  probes:     ${persona.probes ? Object.keys(persona.probes).join(', ') : 'none'}`);
  console.log(`  invariants: ${persona.invariants ? persona.invariants.length : 0}`);
  if (todos.length > 0) {
    console.log(`\n  ${todos.length} field(s) need real values: ${[...new Set(todos)].join(', ')}`);
  }
  console.log(`
This is a draft. The spec describes shapes, not meaning — it cannot tell you
what a correct outcome looks like. Review the body fields, then add the
invariants that matter for your domain.
`);

  return { persona, file };
}

module.exports = { generate, generatePersona, loadSpec };
