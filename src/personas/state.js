'use strict';

const { getPath, interpolate } = require('../interpolate');

/**
 * Actor state: extraction and mutation.
 *
 * Two capabilities personas previously lacked, both of which limited how
 * lifelike a population could be.
 *
 * EXTRACTION used to be positional only — `extract: { id: "0.id" }` always
 * took the first element, so every actor booked the same doctor and claimed
 * the same shipment. That is one user run sixty times, not a population, and
 * it hides exactly the contention bugs the tool exists to find. Selection is
 * drawn from the actor's own seeded stream, so sixty actors make sixty
 * different choices and make the same ones on every replay.
 *
 * MUTATION did not exist at all: an actor could not decrement a budget or
 * increment a counter. Adding it gives economic behaviour, and it gives
 * bounded loops for free — increment a counter, then let the existing
 * `when` condition decide whether to go round again.
 */

/**
 * Resolve one extract rule against a response body.
 *
 * Accepts either the original string path, or:
 *   { path, pick: "random" | "first" | "last" | <index>, field }
 */
function resolveExtract(rule, body, rng, chosen = null) {
  if (typeof rule === 'string') return getPath(body, rule);

  if (!rule || typeof rule !== 'object' || !rule.path) return undefined;

  const target = getPath(body, rule.path);
  if (target === undefined) return undefined;

  if (!Array.isArray(target)) {
    return rule.field ? getPath(target, rule.field) : target;
  }

  if (target.length === 0) return undefined;

  let item;
  const pick = rule.pick === undefined ? 'first' : rule.pick;

  if (pick === 'random') {
    // Drawn from the actor's stream, so the choice is varied AND reproducible.
    //
    // Two rules picking randomly from the SAME path must land on the SAME
    // element. Without this, `{ productId: {path:'products',pick:'random',field:'id'},
    // price: {path:'products',pick:'random',field:'priceMinor'} }` draws twice
    // and the actor buys one product at another's price — a silently wrong
    // persona, which is worse than one that fails loudly.
    if (chosen && chosen.has(rule.path)) {
      item = target[chosen.get(rule.path)];
    } else {
      const index = rng ? rng.int(0, target.length - 1) : 0;
      if (chosen) chosen.set(rule.path, index);
      item = target[index];
    }
  } else if (pick === 'first') {
    item = target[0];
  } else if (pick === 'last') {
    item = target[target.length - 1];
  } else if (Number.isInteger(pick)) {
    item = target[pick];
  } else {
    throw new Error(`Unknown extract pick "${pick}" (use random, first, last, or an index)`);
  }

  if (item === undefined) return undefined;
  return rule.field ? getPath(item, rule.field) : item;
}

/** Apply every extract rule on a state to the actor's vars. */
function applyExtract(extractSpec, body, context, rng) {
  if (!extractSpec || !body) return;
  // Shared within ONE extract block: random picks from the same path agree.
  const chosen = new Map();
  for (const [name, rule] of Object.entries(extractSpec)) {
    const value = resolveExtract(rule, body, rng, chosen);
    if (value !== undefined) context.vars[name] = value;
  }
}

const MUTATIONS = {
  add: (current, operand) => Number(current || 0) + Number(operand),
  subtract: (current, operand) => Number(current || 0) - Number(operand),
  multiply: (current, operand) => Number(current || 0) * Number(operand),
  assign: (_current, operand) => operand
};

/**
 * Apply a state's `set` block.
 *
 *   "set": {
 *     "budget":    { "subtract": "{{vars.price}}" },
 *     "pollCount": { "add": 1 },
 *     "status":    { "assign": "claimed" }
 *   }
 *
 * A bare value is shorthand for assign: "set": { "status": "claimed" }.
 * Operands are interpolated first, so they can reference other vars.
 */
function applySet(setSpec, context) {
  if (!setSpec) return;

  const scope = { vars: context.vars, actor: context.actor };

  for (const [name, spec] of Object.entries(setSpec)) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      context.vars[name] = interpolate(spec, scope);
      continue;
    }

    const entries = Object.entries(spec).filter(([op]) => MUTATIONS[op]);
    if (entries.length === 0) {
      throw new Error(
        `set on "${name}" needs one of: ${Object.keys(MUTATIONS).join(', ')} (or a bare value)`
      );
    }

    for (const [op, rawOperand] of entries) {
      const operand = interpolate(rawOperand, scope);
      const next = MUTATIONS[op](context.vars[name], operand);
      if (op !== 'assign' && Number.isNaN(next)) {
        throw new Error(
          `set ${op} on "${name}" produced NaN — ` +
            `current=${JSON.stringify(context.vars[name])}, operand=${JSON.stringify(operand)}`
        );
      }
      context.vars[name] = next;
    }
  }
}

module.exports = { resolveExtract, applyExtract, applySet, MUTATIONS };
