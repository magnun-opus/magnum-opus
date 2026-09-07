'use strict';

const crypto = require('crypto');
const { query } = require('../db/client');
const { runPersona } = require('../personas/engine');
const { actorStream } = require('../random');
const EventLogger = require('../logger/eventLogger');
const { runProbes, evaluateInvariants } = require('../invariants/evaluate');

/**
 * Builds the actor population. Order is deterministic (sorted persona keys)
 * so actor_index means the same thing across runs of the same seed.
 */
function buildPopulation(personaMix) {
  const population = [];
  for (const personaType of Object.keys(personaMix).sort()) {
    for (let i = 0; i < personaMix[personaType]; i++) population.push(personaType);
  }
  return population;
}

/**
 * Runs the population against the target application.
 *
 * Phase 1 sliced the population into batches joined by Promise.all, which is
 * a barrier, not a load profile: every actor in a batch started at the same
 * instant and the batch waited on its slowest member. This is a worker pool —
 * a slot opens the moment an actor finishes, so overlap is sustained.
 *
 * Set arrivalRatePerSec for an open model instead: inter-arrival times drawn
 * from an exponential distribution (Poisson arrivals), t = -ln(1 - u) / λ.
 */
async function runConcurrent({
  runId,
  seed,
  baseUrl,
  personaMix,
  concurrency = 25,
  arrivalRatePerSec = null,
  idempotency = { enabled: true },
  personas,
  chaos = null,
  epoch = 0,
  buffer,
  registry
}) {
  const population = buildPopulation(personaMix);
  const results = [];
  let nextIndex = 0;
  let completed = 0;

  const takeNext = () => (nextIndex < population.length ? nextIndex++ : -1);

  async function worker() {
    for (;;) {
      const index = takeNext();
      if (index === -1) return;

      const rng = actorStream(seed, index);

      if (arrivalRatePerSec) {
        await sleep(rng.exponentialDelayMs(arrivalRatePerSec));
      } else {
        // Small deterministic start jitter so slots don't fire in lockstep.
        await sleep(rng.range(0, 120));
      }

      const result = await runSingleActor({
        runId,
        seed,
        baseUrl,
        personaType: population[index],
        index,
        rng,
        buffer,
        registry,
        idempotency,
        personas,
        chaos,
        epoch
      });

      results.push(result);
      completed++;
      if (completed % 25 === 0 || completed === population.length) {
        console.log(`  ${completed}/${population.length} actors complete`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, population.length) }, worker);
  await Promise.all(workers);

  return results;
}

async function runSingleActor({
  runId,
  seed,
  baseUrl,
  personaType,
  index,
  rng,
  buffer,
  registry,
  idempotency,
  personas,
  chaos,
  epoch = 0
}) {
  const actorId = crypto.randomUUID();
  const traceId = crypto.randomUUID();

  // Session ids include the epoch so waves never collide.
  const sessionId = epoch > 0 ? `sim-${seed}-e${epoch}-${index}` : `sim-${seed}-${index}`;

  await query(
    `INSERT INTO actors (actor_id, run_id, persona_type, actor_index, synthetic_user_id, seed, epoch, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [actorId, runId, personaType, index, sessionId, rng.seedString, epoch]
  );

  const logger = new EventLogger(runId, actorId, traceId, buffer, epoch);
  const persona = personas[personaType];
  if (!persona) {
    throw new Error(
      `Unknown persona type "${personaType}". Available: ${Object.keys(personas).join(', ')}`
    );
  }

  const actor = { actorId, traceId, index, sessionId, personaType, epoch };
  const effectivePersona =
    idempotency && idempotency.enabled === false
      ? { ...persona, send_idempotency_key: false }
      : persona;

  try {
    const result = await runPersona(effectivePersona, {
      baseUrl,
      logger,
      registry,
      rng,
      actor,
      chaos
    });
    return { actorId, actorIndex: index, personaType, actor, persona, logger, epoch, ...result };
  } catch (err) {
    logger.log({
      eventType: 'decision',
      action: 'actor_error',
      outcome: 'error',
      payload: { error: err.message }
    });
    return {
      actorId,
      actorIndex: index,
      personaType,
      actor,
      persona,
      logger,
      epoch,
      error: err.message
    };
  }
}

/**
 * Post-run verification: fetch each persona's probes, then evaluate its
 * invariants against what came back.
 *
 * Runs AFTER registry.drain(), so requests the client abandoned have already
 * landed their writes — otherwise verification would read a half-settled
 * world and report phantom passes.
 */
async function verifyActors({ baseUrl, results, registry }) {
  for (const result of results) {
    const persona = result.persona;
    if (!persona || !result.context) continue;
    if (!persona.probes && !persona.verification) continue;

    let probes;
    try {
      probes = await runProbes(persona, {
        actor: result.actor,
        context: result.context,
        baseUrl,
        registry,
        logger: result.logger
      });
    } catch (err) {
      result.logger.log({
        eventType: 'invariant',
        action: 'probe_failed',
        outcome: 'skipped',
        payload: { name: 'probe', message: err.message }
      });
      continue;
    }

    const ctx = {
      probes,
      intentCounts: intentCountsFor(result),
      vars: result.context.vars,
      actor: result.actor
    };
    const evaluations = evaluateInvariants(persona, ctx);

    for (const evaluation of evaluations) {
      result.logger.log({
        eventType: 'invariant',
        action: `invariant:${evaluation.name}`,
        outcome: evaluation.skipped ? 'skipped' : evaluation.ok ? 'held' : 'violated',
        payload: evaluation,
        tags: ['invariant']
      });
    }
  }
}

/**
 * How many logical intents of each kind this actor issued. An actor that
 * abandoned may still have caused a write — that is the whole point — so an
 * intent counts once it was attempted, not once it succeeded.
 */
function intentCountsFor(result) {
  const counts = {};
  for (const [intent, attempts] of result.intentAttempts || []) {
    counts[intent] = attempts > 0 ? 1 : 0;
  }
  if (Object.keys(counts).length === 0) {
    const ctx = result.context;
    const issued =
      ctx && (ctx.vars.orderId != null || ctx.vars.retryOrderId != null || ctx.pending.length > 0);
    counts.checkout = issued ? 1 : 0;
  }
  return counts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { runConcurrent, buildPopulation, verifyActors, intentCountsFor };
