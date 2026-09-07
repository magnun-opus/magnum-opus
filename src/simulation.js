'use strict';

const crypto = require('crypto');
const { query } = require('./db/client');
const { runConcurrent, verifyActors } = require('./runner/concurrencyRunner');
const { runEpochs } = require('./temporal/epochs');
const { ChaosPolicy } = require('./chaos');
const { analyze } = require('./analyst/analyst');
const { RequestRegistry } = require('./httpClient');
const { EventBuffer } = require('./logger/eventBuffer');
const { generateSeed } = require('./random');
const { assertTargetAllowed } = require('./safety');
const { loadPersonas, assertMixIsLoadable } = require('./personas/loader');

/**
 * Programmatic entry point. The CLI is a thin wrapper around this, and the
 * integration tests drive it directly — a testing tool that cannot be
 * invoked from a test is a bad sign.
 *
 * Order matters at the end of a run:
 *   1. all actors finish
 *   2. drain() — requests clients gave up on complete their writes
 *   3. verifyActors() — read back the app's state, now that it is settled
 *   4. buffer.close() — flush every queued event
 *   5. analyze() — detectors read a complete log
 */
async function runSimulation({
  config,
  configPath = null,
  seed,
  runId,
  quiet = false,
  acknowledged = false,
  onEpochStart = null
} = {}) {
  const effectiveSeed = seed || config.seed || generateSeed();
  const effectiveRunId = runId || crypto.randomUUID();
  const log = quiet ? () => {} : (...a) => console.log(...a);

  // Refuse non-local targets unless explicitly allowlisted AND acknowledged.
  // This runs before anything is written or sent.
  assertTargetAllowed(config.baseUrl, {
    allowedHosts: config.allowedHosts || [],
    acknowledged: acknowledged || config.acknowledgeNonProduction === true
  });

  const { personas, source, isBuiltin } = loadPersonas({ config, configPath });
  assertMixIsLoadable(config.personaMix, personas, source);
  if (!isBuiltin) log(`Personas: ${source}`);

  await query(
    `INSERT INTO simulation_runs (run_id, config, seed, started_at, status)
     VALUES ($1,$2,$3, now(), 'running')`,
    [effectiveRunId, JSON.stringify({ ...config, seed: effectiveSeed }), effectiveSeed]
  );

  const buffer = new EventBuffer(config.eventBuffer || {});
  const registry = new RequestRegistry();

  const chaos = config.chaos && config.chaos.enabled ? new ChaosPolicy(config.chaos) : null;
  if (chaos) log(`Chaos: ${(chaos.rate * 100).toFixed(0)}% of writes`);

  const common = {
    runId: effectiveRunId,
    seed: effectiveSeed,
    baseUrl: config.baseUrl,
    personaMix: config.personaMix,
    concurrency: config.concurrency || 25,
    arrivalRatePerSec: config.arrivalRatePerSec || null,
    idempotency: config.idempotency || { enabled: true },
    personas,
    chaos,
    buffer,
    registry
  };

  try {
    const epochs = config.epochs && config.epochs.count > 1 ? config.epochs : null;
    if (epochs) log(`Epochs: ${epochs.count} waves`);

    const results = epochs
      ? await runEpochs({ ...common, epochs, log, onEpochStart })
      : await runConcurrent(common);

    log('\nDraining in-flight requests...');
    const stillPending = await registry.drain();
    if (stillPending > 0) log(`  ${stillPending} request(s) never settled`);

    // With epochs, verification already ran after each wave.
    if (!epochs) {
      log('Verifying application state...');
      await verifyActors({ baseUrl: config.baseUrl, results, registry });
    }

    await buffer.close();
    await query(
      `UPDATE simulation_runs SET status = 'completed', ended_at = now() WHERE run_id = $1`,
      [effectiveRunId]
    );

    log('Running analyst...');
    const findings = await analyze(effectiveRunId, config);

    return {
      runId: effectiveRunId,
      seed: effectiveSeed,
      findings,
      results,
      chaosDuplicates: registry.duplicatesSent
    };
  } catch (err) {
    try {
      await buffer.close();
    } catch (_) {}
    await query(
      `UPDATE simulation_runs SET status = 'failed', ended_at = now() WHERE run_id = $1`,
      [effectiveRunId]
    );
    throw err;
  }
}

module.exports = { runSimulation };
