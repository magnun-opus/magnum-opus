'use strict';

/**
 * Centralized condition vocabulary. Every persona reuses these conditions
 * rather than inventing its own transition logic.
 *
 * `context` is the running state threaded through the persona engine and,
 * unlike Phase 1, it PERSISTS across states:
 *   {
 *     lastResponse: { status, ok, timedOut, body, latencyMs } | null,
 *     lastClientOutcome: 'success' | 'error' | 'timeout' | null,
 *     responseArrivedDuringWait: boolean | null,
 *     vars: {},          // extracted values
 *     actor: {},         // identity
 *     pending: []        // handles the client gave up on
 *   }
 */

const { getPath } = require('../interpolate');

const CONDITIONS = {
  always: () => true,

  on_success: (ctx) => ctx.lastClientOutcome === 'success',

  on_error: (ctx) => ctx.lastClientOutcome === 'error',

  /** The client stopped waiting. The request may still be in flight. */
  on_timeout: (ctx) => ctx.lastClientOutcome === 'timeout',

  /** The abandoned request settled while the actor was waiting. */
  response_received_within_wait: (ctx) => ctx.responseArrivedDuringWait === true,

  /** Still nothing after the wait elapsed. */
  no_response_after_wait: (ctx) => ctx.responseArrivedDuringWait === false,

  /**
   * A declarative comparison over the actor's own state, so actors can carry
   * a budget, an inventory or a quota and react to what the application told
   * them:
   *
   *   { "to": "buy", "condition": "when",
   *     "when": { "path": "vars.budget", "gte": { "path": "vars.price" } } }
   *
   * Deliberately a fixed set of operators rather than an expression
   * language — same reasoning as the invariant DSL. A config file should not
   * be able to execute arbitrary code, and every comparison must stay
   * deterministic.
   */
  when: (ctx, transition) => evaluateComparison(transition && transition.when, ctx)
};

const OPERATORS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b)
};

/** Resolve either a literal or a { "path": "vars.x" } reference. */
function resolveOperand(spec, ctx) {
  if (spec !== null && typeof spec === 'object' && spec.path) return getPath(ctx, spec.path);
  return spec;
}

function evaluateComparison(spec, ctx) {
  if (!spec) throw new Error('condition "when" requires a "when" object on the transition');
  const left = resolveOperand({ path: spec.path }, ctx);

  for (const [op, fn] of Object.entries(OPERATORS)) {
    if (spec[op] === undefined) continue;
    const right = resolveOperand(spec[op], ctx);
    if (left === undefined || right === undefined) return false;
    return fn(left, right);
  }
  throw new Error(
    `condition "when" needs one of: ${Object.keys(OPERATORS).join(', ')}`
  );
}

/**
 * Resolve which transition to take.
 *
 * Two rules Phase 1 got wrong:
 *
 * 1. PRECEDENCE. `always` is a fallback, not a peer. If any specific
 *    condition matches, `always` transitions are discarded. Previously a
 *    state with both `always` and `on_success` would roll dice between
 *    them, which is never what the author meant.
 *
 * 2. WEIGHT NORMALISATION. Probabilities are relative weights, normalised
 *    over the surviving pool rather than assumed to sum to 1:
 *      w_i = t.probability ?? 1
 *      W   = sum(w_i)
 *      p_i = w_i / W
 *    Previously a pool whose probabilities summed to less than 1 silently
 *    over-selected the final transition, skewing the distribution.
 */
function resolveTransition(transitions, context, rng = Math.random) {
  if (!Array.isArray(transitions) || transitions.length === 0) return null;

  const matched = transitions.filter((t) => {
    const fn = CONDITIONS[t.condition];
    if (!fn) throw new Error(`Unknown condition: ${t.condition}`);
    return fn(context, t);
  });

  if (matched.length === 0) return null;

  const specific = matched.filter((t) => t.condition !== 'always');
  const pool = specific.length > 0 ? specific : matched;

  if (pool.length === 1) return pool[0];

  const weights = pool.map((t) => (t.probability != null ? Number(t.probability) : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return pool[0];

  const roll = rng();
  let cumulative = 0;
  for (let i = 0; i < pool.length; i++) {
    cumulative += weights[i] / total;
    if (roll < cumulative) return pool[i];
  }
  return pool[pool.length - 1];
}

module.exports = { CONDITIONS, resolveTransition, evaluateComparison, OPERATORS };
