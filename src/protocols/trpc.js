'use strict';

const { interpolate, getPath } = require('../interpolate');

/**
 * tRPC adapter.
 *
 * tRPC is ordinary HTTP, so Magnum Opus could always reach it by writing
 * paths out longhand. Three details made that miserable and error-prone,
 * and this exists to make them impossible to get wrong:
 *
 *   1. INPUT ENCODING. Queries carry their input JSON-stringified into a
 *      query parameter — myQuery?input=<encodeURIComponent(JSON.stringify(x))>
 *      — while mutations send it as the POST body. Hand-encoding JSON into
 *      a URL inside a persona file is a reliable source of silent breakage.
 *
 *   2. THE ENVELOPE. tRPC follows JSON-RPC where it can, so payloads arrive
 *      under `result.data`, not at the top level. Written by hand, every
 *      probe collection becomes "accounts.result.data.accounts" and every
 *      forgotten prefix silently resolves to nothing — an invariant that
 *      checks air and reports a pass.
 *
 *   3. TRANSFORMERS. With superjson (common in tRPC stacks) both input and
 *      output gain another `json` wrapper, on both ends.
 *
 * Unwrapping happens BEFORE extraction, logging and invariants, so persona
 * authors read `accounts.accounts` and never see the envelope at all.
 *
 * Not handled, deliberately: batching. Batched calls join procedures with
 * commas and return 207 Multi-Status, which only matters for a client
 * optimising round trips. The simulator issues one call at a time, and a
 * batched request would make per-procedure timing and outcomes ambiguous —
 * which is most of what the event log is for.
 */

const DEFAULT_PREFIX = '/api/trpc';

function settingsFor(persona) {
  const raw = persona.trpc || {};
  return {
    prefix: raw.prefix || DEFAULT_PREFIX,
    // "superjson" (or any truthy transformer name) adds the json wrapper.
    transformer: raw.transformer || null
  };
}

function wrapInput(input, transformer) {
  if (input === undefined) return undefined;
  return transformer ? { json: input } : input;
}

/**
 * Peel the JSON-RPC envelope, then the transformer wrapper.
 *
 *   { result: { data: { json: X } } } -> X   (with a transformer)
 *   { result: { data: X } }           -> X   (without)
 *
 * Anything that is not shaped like an envelope is returned untouched, so a
 * plain REST response passing through here is unharmed.
 */
function unwrapResponse(body, transformer) {
  if (body == null || typeof body !== 'object') return body;

  // Errors keep their own shape; surfacing the error is more useful than
  // returning undefined because there was no `result`.
  if (body.error !== undefined && body.result === undefined) return body;

  let value = body;
  if (value.result !== undefined) value = value.result;
  else return body;

  if (value && typeof value === 'object' && value.data !== undefined) value = value.data;

  if (transformer && value && typeof value === 'object' && value.json !== undefined) {
    value = value.json;
  }
  return value;
}

/** True if this spec should be handled as a tRPC call. */
function isTrpcSpec(persona, spec) {
  if (!spec) return false;
  if (spec.event_type === 'trpc') return true;
  return Boolean(spec.procedure) && (persona.protocol === 'trpc' || Boolean(persona.trpc));
}

/**
 * Turn a tRPC spec into an ordinary HTTP request.
 *
 * @returns {{method: string, path: string, body: object|undefined, action: string}}
 */
function buildRequest(persona, spec, scope) {
  const { prefix, transformer } = settingsFor(persona);
  const procedure = interpolate(spec.procedure, scope);
  const kind = spec.type || (spec.input !== undefined ? 'query' : 'query');
  const input = spec.input !== undefined ? interpolate(spec.input, scope) : undefined;
  const wrapped = wrapInput(input, transformer);

  const base = `${prefix.replace(/\/$/, '')}/${procedure}`;

  if (kind === 'mutation') {
    return {
      method: 'POST',
      path: base,
      body: wrapped === undefined ? {} : wrapped,
      // The logged action stays readable: the procedure, not an encoded URL.
      action: `POST ${base}`
    };
  }

  const query =
    wrapped === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(wrapped))}`;

  return {
    method: 'GET',
    path: `${base}${query}`,
    body: undefined,
    // Query string omitted from the action so findings group by procedure
    // rather than by each actor's distinct input.
    action: `GET ${base}`
  };
}

/** Unwrap using this persona's transformer setting. */
function unwrapFor(persona, body) {
  return unwrapResponse(body, settingsFor(persona).transformer);
}

module.exports = {
  isTrpcSpec,
  buildRequest,
  unwrapResponse,
  unwrapFor,
  settingsFor,
  getPath,
  DEFAULT_PREFIX
};
