'use strict';

const { RequestRegistry } = require('../httpClient');
const { runPersona } = require('../personas/engine');
const { RandomStream } = require('../random');
const { loadPersonas, assertMixIsLoadable } = require('../personas/loader');
const { runProbes } = require('../invariants/evaluate');
const { assertTargetAllowed } = require('../safety');

/**
 * Smoke test: run ONE actor per persona and report which endpoints answered.
 *
 * Why this exists: a full run against a misconfigured target burns ninety
 * seconds and produces a report full of findings about nothing — 100% error
 * rate, high abandonment, and no way to tell that the cause was a wrong port
 * rather than a broken application. Three seconds of evidence beforehand is
 * worth more than any amount of analysis afterwards.
 *
 * Two deliberate constraints:
 *
 *   NO DATABASE WRITES. This builds its own in-memory logger instead of
 *   going through the runner, so validate works before "setup" has ever been
 *   run and never puts a junk run in your event log.
 *
 *   PROBES ARE CHECKED TOO. An unreachable probe is what made invariants
 *   unverifiable, so validate reports probe reachability explicitly rather
 *   than leaving it to be discovered after a full run.
 */
class MemoryLogger {
  constructor(actor) {
    this.actor = actor;
    this.events = [];
  }

  log(evt) {
    const id = `mem-${this.events.length}`;
    this.events.push({ ...evt, id, persona: this.actor.personaType });
    return id;
  }
}

function statusLabel(event) {
  if (event.outcome === 'success') return `HTTP ${event.httpStatus}`;
  if (event.outcome === 'timeout') return 'no response within patience';
  if (event.outcome === 'error') return `HTTP ${event.httpStatus ?? '—'}`;
  return event.outcome;
}

async function validate({ config, configPath = null, cwd = process.cwd(), acknowledged = false } = {}) {
  assertTargetAllowed(config.baseUrl, {
    allowedHosts: config.allowedHosts || [],
    acknowledged: acknowledged || config.acknowledgeNonProduction === true
  });

  const { personas, source, isBuiltin } = loadPersonas({ config, configPath, cwd });
  assertMixIsLoadable(config.personaMix, personas, source);

  console.log(`\nValidating against ${config.baseUrl}`);
  console.log(`Personas from ${isBuiltin ? 'built-in defaults' : source}\n`);

  const registry = new RequestRegistry({ hardCeilingMs: 10000 });
  const report = [];

  for (const personaType of Object.keys(config.personaMix)) {
    const persona = personas[personaType];
    const actor = {
      actorId: 'validate',
      traceId: '00000000-0000-0000-0000-000000000000',
      index: 0,
      sessionId: `validate-${personaType}`,
      personaType
    };
    const logger = new MemoryLogger(actor);
    const rng = new RandomStream(`validate:${personaType}`);

    let outcome;
    let failure = null;
    try {
      const result = await runPersona(persona, {
        baseUrl: config.baseUrl,
        logger,
        registry,
        rng,
        actor
      });
      outcome = result.finalState;
    } catch (err) {
      failure = err.message;
      outcome = 'error';
    }

    // Probes are the usual cause of unverifiable invariants, so exercise them.
    let probeResults = {};
    if (persona.probes || persona.verification) {
      try {
        const context = { vars: {}, actor };
        const probes = await runProbes(persona, {
          actor,
          context,
          baseUrl: config.baseUrl,
          registry,
          logger
        });
        for (const [name, body] of Object.entries(probes)) {
          probeResults[name] = body && body.__unreachable ? 'unreachable' : 'ok';
        }
      } catch (err) {
        probeResults = { error: err.message };
      }
    }

    report.push({ personaType, logger, outcome, failure, probeResults, persona });
  }

  await registry.drain(12000);
  return print(report, config);
}

function print(report, config) {
  let anyFailure = false;
  const endpointStatus = new Map();

  for (const entry of report) {
    console.log(`  ${entry.personaType}`);

    const requests = entry.logger.events.filter(
      (e) => e.eventType === 'http_request' || e.eventType === 'probe'
    );

    if (requests.length === 0) {
      console.log('    (no requests were made — check the persona has an http_request state)');
      anyFailure = true;
    }

    for (const event of requests) {
      const ok = event.outcome === 'success';
      if (!ok) anyFailure = true;
      const endpoint = String(event.action).split('?')[0];
      endpointStatus.set(endpoint, ok);
      console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${endpoint.padEnd(34)} ${statusLabel(event)}`);
    }

    for (const [name, state] of Object.entries(entry.probeResults)) {
      const ok = state === 'ok';
      if (!ok) anyFailure = true;
      console.log(`    ${ok ? 'ok  ' : 'FAIL'}  probe "${name}"`.padEnd(46) + ` ${state}`);
    }

    if (entry.failure) {
      console.log(`    FAIL  persona error: ${entry.failure}`);
      anyFailure = true;
    }

    console.log(`    finished in state: ${entry.outcome}\n`);
  }

  const total = endpointStatus.size;
  const working = [...endpointStatus.values()].filter(Boolean).length;

  console.log(`${working} of ${total} endpoint(s) responded successfully.\n`);

  if (anyFailure) {
    console.log(
      'Fix the failures above before running a full simulation. A run against\n' +
        'endpoints that do not answer produces findings about the configuration,\n' +
        'not about the application.\n'
    );
  } else {
    console.log(`Ready. Next: magnum-opus run --config ${config.__path || 'your config'}\n`);
  }

  return { ok: !anyFailure, working, total };
}

module.exports = { validate };
