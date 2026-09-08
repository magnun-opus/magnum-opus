'use strict';

/**
 * Template resolution for persona definitions.
 *
 * Persona files reference simulation state with {{ }} placeholders:
 *   "GET /products/{{vars.productId}}"
 *   { "sessionId": "{{actor.sessionId}}" }
 *
 * Two resolution modes, deliberately:
 *   - A string that is EXACTLY one placeholder resolves to the raw typed
 *     value ("{{vars.productId}}" -> 3, the number).
 *   - A string containing a placeholder among other text resolves by
 *     stringification ("/products/{{vars.productId}}" -> "/products/3").
 *
 * Without the first rule every extracted value would be coerced to a
 * string, which breaks JSON bodies against typed APIs.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g;
const EXACT_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}$/;

/**
 * Read a dotted path out of an object. Supports array indexes:
 *   getPath({a:{b:[{c:1}]}}, 'a.b[0].c') -> 1
 * Returns undefined for any missing link rather than throwing.
 */
function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let cursor = obj;
  for (const part of parts) {
    if (cursor == null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Resolve every placeholder in a value of any shape (string, array, object).
 * Unknown references throw — a persona referencing a variable that was never
 * set is a definition bug, and failing loudly beats silently sending
 * "undefined" to the application under test.
 */
function interpolate(value, scope) {
  if (typeof value === 'string') {
    const exact = value.match(EXACT_PLACEHOLDER);
    if (exact) {
      const resolved = getPath(scope, exact[1]);
      if (resolved === undefined) {
        throw new Error(`Unresolved template reference: {{${exact[1]}}}`);
      }
      return resolved;
    }
    return value.replace(PLACEHOLDER, (_, ref) => {
      const resolved = getPath(scope, ref);
      if (resolved === undefined) {
        throw new Error(`Unresolved template reference: {{${ref}}}`);
      }
      return String(resolved);
    });
  }

  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));

  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope);
    return out;
  }

  return value;
}

/** True if the value contains at least one placeholder anywhere. */
function hasPlaceholder(value) {
  if (typeof value === 'string') return PLACEHOLDER.test(value.replace(PLACEHOLDER, '$&'));
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(hasPlaceholder);
  return false;
}

module.exports = { interpolate, getPath, hasPlaceholder };
