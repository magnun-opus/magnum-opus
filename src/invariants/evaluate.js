'use strict';

const { interpolate, getPath } = require('../interpolate');
const trpc = require('../protocols/trpc');

/**
 * Invariant evaluation.
 *
 * Phase 1.5 had one hardcoded check: fetch a URL, count records, compare to
 * intents. That is generalised here into declarative invariants over named
 * probes, so you can state a business truth in config instead of writing a
 * detector.
 *
 * A persona declares probes (things to fetch after the run settles) and
 * invariants (claims that must hold over what they returned):
 *
 *   "probes": {
 *     "orders": { "action": "GET /orders?sessionId={{actor.sessionId}}" }
 *   },
 *   "invariants": [
 *     { "name": "one order per checkout",
 *       "type": "count", "collection": "orders.orders",
 *       "atMost": { "intents": "checkout" } },
 *     { "name": "order ids distinct",
 *       "type": "unique", "collection": "orders.orders", "field": "id" },
 *     { "name": "totals conserved",
 *       "type": "conservation",
 *       "sum": { "collection": "orders.orders", "field": "total_cents" },
 *       "equals": { "path": "orders.expectedTotalCents" }, "tolerance": 0 }
 *   ]
 *
 * Types are deliberately a small closed set rather than a general expression
 * language: easier to report on, impossible to make non-deterministic, and
 * no arbitrary code from a config file.
 */

const TYPES = {
  /** Collection size against a bound. */
  count(inv, ctx) {
    const resolved = resolveCollection(inv.collection, ctx);
    if (resolved.state !== 'found') return skip(inv, resolved.reason);
    const items = resolved.items;
    const actual = items.length;

    const bound = resolveBound(inv.atMost ?? inv.equals ?? inv.atLeast, ctx);
    if (bound === null) return skip(inv, 'bound could not be resolved');

    let ok;
    let relation;
    if (inv.atMost !== undefined) {
      ok = actual <= bound;
      relation = `<= ${bound}`;
    } else if (inv.atLeast !== undefined) {
      ok = actual >= bound;
      relation = `>= ${bound}`;
    } else {
      ok = actual === bound;
      relation = `== ${bound}`;
    }

    return {
      name: inv.name,
      type: 'count',
      ok,
      detail: { collection: inv.collection, actual, expected: bound, relation },
      message: ok
        ? `${inv.collection} count ${actual} satisfies ${relation}`
        : `${inv.collection} holds ${actual} record(s), expected ${relation}`
    };
  },

  /** Field values across a collection must be distinct. */
  unique(inv, ctx) {
    const resolved = resolveCollection(inv.collection, ctx);
    if (resolved.state !== 'found') return skip(inv, resolved.reason);
    const items = resolved.items;
    const seen = new Map();
    const duplicates = [];
    for (const item of items) {
      const key = JSON.stringify(getPath(item, inv.field));
      if (seen.has(key)) duplicates.push(JSON.parse(key));
      else seen.set(key, true);
    }
    const ok = duplicates.length === 0;
    return {
      name: inv.name,
      type: 'unique',
      ok,
      detail: { collection: inv.collection, field: inv.field, duplicates: duplicates.slice(0, 5) },
      message: ok
        ? `${inv.field} is distinct across ${items.length} record(s) in ${inv.collection}`
        : `${inv.field} repeats in ${inv.collection}: ${duplicates.slice(0, 3).join(', ')}`
    };
  },

  /**
   * Every item's field must lie within a range.
   *
   *   |{ x in collection : x.field < min or x.field > max }| = 0
   *
   * This is the type four domains reached for and could not express:
   * inventory never negative, balance >= 0, dosage within a safe range,
   * delivery time within SLA. A single violating row is a finding — unlike
   * `count`, an aggregate tells you nothing here, because one negative
   * balance among ten thousand is still a broken system.
   *
   * Works on a scalar too: point `collection` at a single value and it is
   * treated as a collection of one.
   */
  bounds(inv, ctx) {
    const resolved = resolveCollection(inv.collection, ctx);
    if (resolved.state !== 'found') return skip(inv, resolved.reason);

    const min = inv.min !== undefined ? resolveBound(inv.min, ctx) : null;
    const max = inv.max !== undefined ? resolveBound(inv.max, ctx) : null;
    if (min === null && max === null) {
      return skip(inv, 'bounds needs at least one of "min" or "max"');
    }

    const violations = [];
    for (const item of resolved.items) {
      const raw = inv.field ? getPath(item, inv.field) : item;
      if (raw === undefined || raw === null) {
        if (inv.required) violations.push({ item, reason: `"${inv.field}" is missing` });
        continue;
      }
      const value = Number(raw);
      if (Number.isNaN(value)) {
        violations.push({ item, value: raw, reason: 'not a number' });
        continue;
      }
      if (min !== null && value < min) violations.push({ item, value, reason: `below ${min}` });
      else if (max !== null && value > max) violations.push({ item, value, reason: `above ${max}` });
    }

    const ok = violations.length === 0;
    const range = [min !== null ? `>= ${min}` : null, max !== null ? `<= ${max}` : null]
      .filter(Boolean)
      .join(' and ');

    return {
      name: inv.name,
      type: 'bounds',
      ok,
      detail: {
        collection: inv.collection,
        field: inv.field,
        min,
        max,
        checked: resolved.items.length,
        violations: violations.slice(0, 5)
      },
      message: ok
        ? `${inv.field || inv.collection} is ${range} across ${resolved.items.length} record(s)`
        : `${violations.length} of ${resolved.items.length} record(s) break ${inv.field || 'the value'} ${range} ` +
          `(e.g. ${JSON.stringify(violations[0].value)} ${violations[0].reason})`
    };
  },

  /**
   * Every item's field must be present, and optionally match a pattern.
   *
   * For formats a schema cannot express: a tracking number shaped
   * SHIP-XXXXX, a reference with a required prefix, an IBAN. The pattern is
   * a string compiled to a RegExp — no flags are accepted, so a config file
   * cannot smuggle in behaviour.
   */
  match(inv, ctx) {
    const resolved = resolveCollection(inv.collection, ctx);
    if (resolved.state !== 'found') return skip(inv, resolved.reason);

    let pattern = null;
    let source = inv.pattern;
    if (source) {
      // Patterns routinely reference the actor: "^{{vars.userId}}$" is how a
      // persona asserts that every record belongs to the actor who asked.
      // Substituted values are regex-escaped, so a value containing "." or
      // "(" cannot silently change what the pattern means.
      source = resolvePattern(source, ctx);
      try {
        pattern = new RegExp(source);
      } catch (err) {
        return skip(inv, `invalid pattern: ${err.message}`);
      }
    }

    const violations = [];
    for (const item of resolved.items) {
      const value = inv.field ? getPath(item, inv.field) : item;
      if (value === undefined || value === null || value === '') {
        violations.push({ value, reason: 'missing' });
        continue;
      }
      if (pattern && !pattern.test(String(value))) {
        violations.push({ value, reason: `does not match ${source}` });
      }
    }

    const ok = violations.length === 0;
    return {
      name: inv.name,
      type: 'match',
      ok,
      detail: {
        collection: inv.collection,
        field: inv.field,
        pattern: source || null,
        checked: resolved.items.length,
        violations: violations.slice(0, 5)
      },
      message: ok
        ? `${inv.field} is present${source ? ` and matches ${source}` : ''} across ${resolved.items.length} record(s)`
        : `${violations.length} of ${resolved.items.length} record(s): ${inv.field} ${violations[0].reason}`
    };
  },

  /**
   * A total that must balance:  |sum(field) - expected| <= tolerance
   * Tolerance exists for currency rounding and float drift; it defaults to 0
   * because for integer money it should be exact.
   */
  conservation(inv, ctx) {
    const resolved = resolveCollection(inv.sum.collection, ctx);
    if (resolved.state !== 'found') return skip(inv, resolved.reason);
    const items = resolved.items;
    const total = items.reduce((acc, item) => acc + Number(getPath(item, inv.sum.field) || 0), 0);

    const expected = resolveBound(inv.equals, ctx);
    if (expected === null) return skip(inv, 'expected value could not be resolved');

    const tolerance = inv.tolerance ?? 0;
    const drift = Math.abs(total - expected);
    const ok = drift <= tolerance;

    return {
      name: inv.name,
      type: 'conservation',
      ok,
      detail: {
        collection: inv.sum.collection,
        field: inv.sum.field,
        total,
        expected,
        drift,
        tolerance
      },
      message: ok
        ? `sum(${inv.sum.field}) = ${total} matches expected ${expected}`
        : `sum(${inv.sum.field}) = ${total} but expected ${expected} (drift ${drift}, tolerance ${tolerance})`
    };
  }
};

/** Escape every regex metacharacter in a substituted value. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve {{vars.x}} / {{actor.y}} inside a pattern, escaping the values. */
function resolvePattern(source, ctx) {
  return String(source).replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (whole, ref) => {
    const value = getPath({ vars: ctx.vars || {}, actor: ctx.actor || {} }, ref);
    return value === undefined ? whole : escapeRegex(value);
  });
}

function skip(inv, why) {
  return {
    name: inv.name,
    type: inv.type,
    ok: null,
    skipped: true,
    detail: { reason: why },
    message: `${inv.name} skipped: ${why}`
  };
}

/**
 * Three-state collection resolution.
 *
 * This is the fix for the worst bug the tool has had. Previously an
 * unresolvable collection returned [], so "0 records <= 1 intent" PASSED and
 * the report said the invariant HELD. A run in which every single request
 * failed still produced a green invariant line. "I could not check" was
 * being reported as "I checked and it is fine", which is worse than a false
 * positive: a false positive wastes an hour, a false green ships the bug.
 *
 * Two distinct causes, both now surfaced:
 *   unreachable — the probe request itself failed
 *   missing     — the probe answered, but nothing exists at that path,
 *                 which usually means the collection path is a typo
 *
 * @returns {{state:'found'|'unreachable'|'missing', items?: any[], reason?: string}}
 */
function resolveCollection(pathExpr, ctx) {
  const probeName = String(pathExpr).split('.')[0];
  const probe = ctx.probes ? ctx.probes[probeName] : undefined;

  if (probe === undefined) {
    return { state: 'missing', reason: `no probe named "${probeName}" was declared` };
  }
  if (probe && probe.__unreachable) {
    return {
      state: 'unreachable',
      reason: `probe "${probeName}" could not be reached${probe.__reason ? ` (${probe.__reason})` : ''}`
    };
  }

  const value = getPath(ctx.probes, pathExpr);
  if (value === undefined || value === null) {
    return {
      state: 'missing',
      reason: `nothing found at "${pathExpr}" in the probe response — check the path`
    };
  }
  return { state: 'found', items: Array.isArray(value) ? value : [value] };
}

/**
 * A bound is a literal number, a reference to a probe path, or a count of
 * logical intents the actor issued ({ "intents": "checkout" }).
 */
function resolveBound(spec, ctx) {
  if (spec === undefined || spec === null) return null;
  if (typeof spec === 'number') return spec;
  if (typeof spec === 'object') {
    if (spec.intents) return ctx.intentCounts[spec.intents] ?? 0;
    if (spec.path) {
      const v = getPath(ctx.probes, spec.path);
      return v == null ? null : Number(v);
    }
    if (spec.value != null) return Number(spec.value);
  }
  return null;
}

/** Fetch every probe a persona declares, after in-flight requests settle. */
async function runProbes(persona, { actor, context, baseUrl, registry, logger }) {
  const probes = {};

  // Backward compatibility: Phase 1.5's single `verification` block becomes
  // a probe named "verification" plus an implicit count invariant.
  const specs = { ...(persona.probes || {}) };
  if (persona.verification && !specs.verification) {
    specs.verification = { action: persona.verification.action };
  }

  for (const [name, spec] of Object.entries(specs)) {
    const scope = { vars: context.vars, actor };
    const isTrpc = trpc.isTrpcSpec(persona, spec);
    const built = isTrpc
      ? trpc.buildRequest(persona, spec, scope)
      : (() => {
          const a = interpolate(spec.action, scope);
          const [m, p] = a.split(' ');
          return { action: a, method: m, path: p };
        })();
    const { action, method, path } = built;

    // Probes must carry the actor's session. Without this, every probe
    // against an authenticated application returns 401 and every invariant
    // becomes unverifiable — the feature would be useless on any real app.
    const handle = registry.dispatch(baseUrl, method, path, {
      headers: {
        ...(context.authHeaders || {}),
        ...(spec.headers ? interpolate(spec.headers, { vars: context.vars, actor }) : {})
      }
    });
    const settled = await registry.awaitSettled(handle, spec.timeout_ms || 10000);
    const reachable = settled.resolved && settled.result.ok;
    // Unwrapped here, so an invariant reads "accounts.accounts" rather than
    // "accounts.result.data.json.accounts" — a prefix easy to forget, and one
    // that silently resolves to nothing when forgotten, turning an invariant
    // into a check on air.
    const body = reachable
      ? isTrpc
        ? trpc.unwrapFor(persona, settled.result.body)
        : settled.result.body
      : {
          __unreachable: true,
          __reason: settled.resolved
            ? `HTTP ${settled.result.status}`
            : 'no response within probe timeout'
        };
    probes[name] = body;

    // Probe responses are logged as events, not just consumed in memory.
    // A tenant leak usually surfaces HERE — a listing endpoint returning
    // rows belonging to other sessions — so the isolation detector needs
    // these bodies in the event log to scan them.
    if (logger) {
      logger.log({
        eventType: 'probe',
        action,
        outcome: settled.resolved && settled.result.ok ? 'success' : 'unreachable',
        latencyMs: settled.resolved ? settled.result.latencyMs : null,
        httpStatus: settled.resolved ? settled.result.status : null,
        payload: { probe: name, response: body },
        tags: ['probe']
      });
    }
  }

  return probes;
}

function buildInvariantList(persona) {
  const list = [...(persona.invariants || [])];
  if (persona.verification && !persona.invariants) {
    const collection = persona.verification.collection || 'orders';
    list.push({
      name: `one ${collection.replace(/s$/, '')} per intent`,
      type: 'count',
      collection: `verification.${collection}`,
      atMost: { intents: 'checkout' }
    });
  }
  return list;
}

function evaluateInvariants(persona, ctx) {
  const results = [];
  for (const inv of buildInvariantList(persona)) {
    const evaluator = TYPES[inv.type];
    if (!evaluator) {
      results.push(skip(inv, `unknown invariant type "${inv.type}"`));
      continue;
    }
    try {
      results.push(evaluator(inv, ctx));
    } catch (err) {
      results.push(skip(inv, err.message));
    }
  }
  return results;
}

module.exports = { runProbes, evaluateInvariants, buildInvariantList, TYPES, resolveBound };
