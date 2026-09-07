'use strict';

const { runConcurrent, verifyActors } = require('../runner/concurrencyRunner');

/**
 * Time compression via epochs.
 *
 * Stated plainly: this cannot move your application's clock. What it does is
 * accrete world state in waves and measure how the application behaves as
 * data piles up — which is where a distinct class of bug lives that no
 * single-wave load test reaches: unbounded table growth, missing indexes,
 * queries that were fine at a hundred rows and fall over at fifty thousand.
 *
 * If your application accepts a simulated-clock header, set
 * epochs.clockHeader and each wave advances it by stepDays, which gets you
 * real time travel: expiring tokens, fiscal-year rollovers, retention jobs.
 *
 * Each epoch is a full population run. Actor streams are namespaced by epoch
 * so waves are independent but still reproducible from the run seed.
 */
async function runEpochs({
  runId,
  seed,
  baseUrl,
  personaMix,
  concurrency,
  arrivalRatePerSec,
  idempotency,
  personas,
  chaos,
  epochs,
  buffer,
  registry,
  onEpochStart = null,
  log = console.log
}) {
  const count = epochs.count || 1;
  const stepDays = epochs.stepDays || 0;
  const startDate = epochs.startDate ? new Date(epochs.startDate) : new Date();

  const all = [];

  for (let epoch = 1; epoch <= count; epoch++) {
    const simulatedDate = new Date(startDate.getTime() + (epoch - 1) * stepDays * 86400000);

    if (epochs.clockHeader) {
      // The registry stamps this on every request, so the application sees a
      // consistent simulated "now" for the whole wave.
      registry.defaultHeaders = {
        ...(registry.defaultHeaders || {}),
        [epochs.clockHeader]: simulatedDate.toISOString()
      };
    }

    // Actors accrete state by running, but real elapsed time also accretes
    // state from everyone else. onEpochStart lets a harness age the world
    // between waves — for the bundled demo, inserting historical rows so the
    // effect is visible in seconds rather than months.
    if (onEpochStart) {
      const reported = await onEpochStart({ epoch, simulatedDate, count });
      if (reported && reported.size != null) {
        buffer.push({
          event_id: require('crypto').randomUUID(),
          run_id: runId,
          actor_id: null,
          trace_id: '00000000-0000-0000-0000-000000000000',
          parent_event_id: null,
          occurred_at: new Date(),
          trace_sequence: epoch,
          epoch,
          event_type: 'world_state',
          action: 'world_state',
          outcome: 'recorded',
          latency_ms: null,
          http_status: null,
          idempotency_key: null,
          attempt_number: null,
          payload: JSON.stringify({ size: reported.size, simulatedDate }),
          tags: ['epoch']
        });
      }
    }

    log(
      `\n--- epoch ${epoch}/${count}` +
        (stepDays ? ` (simulated ${simulatedDate.toISOString().slice(0, 10)})` : '') +
        ' ---'
    );

    const results = await runConcurrent({
      runId,
      seed: `${seed}:epoch${epoch}`,
      baseUrl,
      personaMix,
      concurrency,
      arrivalRatePerSec,
      idempotency,
      personas,
      chaos,
      epoch,
      buffer,
      registry
    });

    all.push(...results.map((r) => ({ ...r, epoch })));

    // Let this wave's writes settle before verifying, or the probes read a
    // half-finished world.
    await registry.drain(15000);

    // Verification runs PER EPOCH, not once at the end. Verifying only at the
    // end would measure the final world state for every wave — which makes
    // the growth curve perfectly flat and hides exactly the degradation this
    // mode exists to find. It is also the correct semantics: an invariant
    // about epoch 1 should be judged against the world as it was in epoch 1.
    await verifyActors({ baseUrl, results, registry });
  }

  return all;
}

module.exports = { runEpochs };
