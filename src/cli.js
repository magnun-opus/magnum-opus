#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { closePool, query } = require('./db/client');
const { runSimulation } = require('./simulation');
const { generateSeed } = require('./random');
const { init } = require('./commands/init');
const { diffRuns, filterFlaky, printDiff } = require('./commands/diff');
const { generate } = require('./commands/generate');
const { doctor } = require('./commands/doctor');
const { validate } = require('./commands/validate');
const { setup: interactiveSetup } = require('./commands/setup');
const { toSarif } = require('./report/sarif');
const { toJUnit } = require('./report/junit');
const { buildHtmlReport } = require('./report/html');

const USAGE = `
Magnum Opus — simulate a synthetic world around your application.

Commands:
  doctor                     Check Node, database, target, ports and personas
  setup                      Create the databases, write .env, apply the schema
  validate                   Run one actor and report which endpoints answer
  init                       Scaffold magnum/ with a config and persona template
                             --domain <name> for a domain pack (see below)
  generate                   Draft a persona from an OpenAPI document
  run                        Run a simulation and report findings
  report                     Build a standalone HTML report for a run
  diff                       Compare the findings of two runs

Run options:
  --config <path>            Config file            (default: magnum/config.json)
  --seed <string>            Reproducible seed      (default: generated, printed)
  --target <url>             Override baseUrl       (env: MAGNUM_TARGET_URL)
  --fail-on <level>          critical | warning | none          (default: critical)
  --repeat <n>               Run n times and keep only stable findings
  --min-occurrences <k>      Findings must appear in k of n runs (default: 2)
  --format <list>            json,sarif,junit,html  (default: json)
  --out <dir>                Report directory       (default: reports)
  --i-know-this-is-not-production
                             Required, with allowedHosts, for a non-local target

Init options:
  --domain <name>            banking, ecommerce, erp, food-delivery,
                             logistics, marketplace, saas
  --dir <path>               Scaffold into a different directory
  --force                    Overwrite an existing config.json

Setup options:
  --db <url>                 Postgres URL (skips prompts)
  --target <url>             URL of the app under test
  --non-interactive          Never prompt; requires --db

Generate options:
  --spec <path>              OpenAPI JSON document
  --name <name>              Persona name (default: derived from the spec title)

Report options:
  --run-id <id>              Run to render (default: the most recent)
  --out <dir>                Output directory       (default: reports)

Diff options:
  --baseline <runId>         Run to compare against
  --candidate <runId>        Run to evaluate

Examples:
  npx magnum-opus setup
  npx magnum-opus doctor
  npx magnum-opus validate
  npx magnum-opus generate --spec openapi.json
  npx magnum-opus run --config magnum/config.json --seed nightly-01
  npx magnum-opus run --repeat 5 --min-occurrences 3 --format json,sarif
  npx magnum-opus report
  npx magnum-opus diff --baseline <id> --candidate <id>
`;

const FLAGS = new Set(['i-know-this-is-not-production', 'non-interactive', 'force']);

function parseArgs(argv) {
  const args = { command: argv[0], _: [] };
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (FLAGS.has(key)) args[key] = true;
    else {
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function resolveConfigPath(given) {
  if (given) return path.resolve(given);
  for (const candidate of ['magnum/config.json', 'config/default.json']) {
    const full = path.resolve(candidate);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(
    'No config file found. Looked for magnum/config.json and config/default.json.\n' +
      'Run "npx magnum-opus init" to create one, or pass --config <path>.'
  );
}

function printReport(runId, seed, findings) {
  const by = (s) => findings.filter((f) => f.severity === s);
  const critical = by('critical');
  const warning = by('warning');
  const info = by('info');

  console.log('\n' + '='.repeat(64));
  console.log('MAGNUM OPUS — SIMULATION REPORT');
  console.log(`Run:  ${runId}`);
  console.log(`Seed: ${seed}   (re-run with --seed ${seed} to reproduce)`);
  console.log('='.repeat(64));
  console.log(`${critical.length} Critical   ${warning.length} Warning   ${info.length} Info\n`);

  for (const f of findings) {
    console.log(`[${f.severity.toUpperCase().padEnd(8)}] ${f.detector}`);
    console.log(`  ${f.summary}`);
    if (f.stability != null && f.stability < 1) {
      console.log(`  seen in ${f.occurrences}/${f.runCount} runs`);
    }
    if (f.evidence_trace_ids?.length) console.log(`  trace: ${f.evidence_trace_ids[0]}`);
    console.log('');
  }

  if (findings.length === 0) console.log('No issues detected by the enabled detectors.\n');
  console.log('='.repeat(64) + '\n');
}

function writeReports({ formats, outDir, runId, seed, config, configPath, findings }) {
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];

  if (formats.includes('json')) {
    const p = path.join(dir, `${runId}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          runId,
          seed,
          config,
          summary: {
            critical: findings.filter((f) => f.severity === 'critical').length,
            warning: findings.filter((f) => f.severity === 'warning').length,
            info: findings.filter((f) => f.severity === 'info').length
          },
          findings,
          generatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    written.push(p);
  }

  if (formats.includes('sarif')) {
    const p = path.join(dir, `${runId}.sarif`);
    fs.writeFileSync(
      p,
      JSON.stringify(toSarif({ findings, config, configPath, seed, runId }), null, 2)
    );
    written.push(p);
  }

  if (formats.includes('junit')) {
    const p = path.join(dir, `${runId}.junit.xml`);
    fs.writeFileSync(p, toJUnit({ findings, seed, runId }));
    written.push(p);
  }

  return written;
}

function exitCodeFor(findings, failOn) {
  if (failOn === 'none') return 0;
  const levels = failOn === 'warning' ? ['critical', 'warning'] : ['critical'];
  return findings.some((f) => levels.includes(f.severity)) ? 1 : 0;
}

async function commandRun(args) {
  const configPath = resolveConfigPath(args.config);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const target = args.target || process.env.MAGNUM_TARGET_URL;
  if (target) config.baseUrl = target;

  const seed = args.seed || config.seed || generateSeed();
  const failOn = args['fail-on'] || config.failOn || 'critical';
  const formats = String(args.format || 'json')
    .split(',')
    .map((f) => f.trim());
  const repeat = Math.max(1, Number(args.repeat || 1));
  const minOccurrences = Number(args['min-occurrences'] || Math.min(2, repeat));

  console.log(`Config: ${path.relative(process.cwd(), configPath)}`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Seed:   ${seed}`);

  const runIds = [];
  let last;

  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) console.log(`\n--- run ${i + 1} of ${repeat} ---`);
    last = await runSimulation({
      config,
      configPath,
      seed,
      acknowledged: args['i-know-this-is-not-production'] === true
    });
    runIds.push(last.runId);
  }

  let findings = last.findings;

  // Repeated runs: the app, its database and the network still vary even with
  // a fixed seed, so keep only findings that recur.
  if (repeat > 1) {
    const { stable, flaky } = await filterFlaky(runIds, minOccurrences);
    console.log(
      `\nFlake filter: ${stable.length} stable, ${flaky.length} discarded ` +
        `(needed ${minOccurrences} of ${repeat} runs)`
    );
    findings = stable;
  }

  printReport(last.runId, seed, findings);

  const written = writeReports({
    formats,
    outDir: args.out || 'reports',
    runId: last.runId,
    seed,
    config,
    configPath: path.relative(process.cwd(), configPath),
    findings
  });
  if (formats.includes('html')) {
    written.push(await writeHtml(last.runId, args.out || 'reports'));
  }

  for (const p of written) console.log(`Report: ${p}`);
  if (repeat > 1) console.log(`\nRun ids: ${runIds.join(' ')}`);

  return exitCodeFor(findings, failOn);
}

async function writeHtml(runId, outDir) {
  const { html } = await buildHtmlReport(runId);
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.html`);
  fs.writeFileSync(file, html);
  return file;
}

async function commandReport(args) {
  let runId = args['run-id'];
  if (!runId) {
    const { rows } = await query(
      `SELECT run_id FROM simulation_runs ORDER BY started_at DESC LIMIT 1`
    );
    if (rows.length === 0) {
      console.error('No runs found. Run a simulation first.');
      return 1;
    }
    runId = rows[0].run_id;
    console.log(`No --run-id given; using the most recent run ${runId}`);
  }

  const file = await writeHtml(runId, args.out || 'reports');
  console.log(`\nReport: ${file}`);
  console.log('Open it in a browser — it is self-contained, with no external assets.\n');
  return 0;
}

async function commandDiff(args) {
  if (!args.baseline || !args.candidate) {
    console.error('diff requires --baseline <runId> and --candidate <runId>');
    return 1;
  }
  const result = await diffRuns(args.baseline, args.candidate);
  printDiff(result);
  return result.introduced.length > 0 ? 1 : 0;
}

async function commandSetup(args) {
  const result = await interactiveSetup({
    interactive: args['non-interactive'] !== true,
    db: args.db,
    target: args.target
  });
  return result.ok ? 0 : 1;
}

/**
 * doctor and validate must work BEFORE a config exists — that is much of
 * their point — so a missing config is information, not an error.
 */
function loadConfigIfPresent(given) {
  try {
    const configPath = resolveConfigPath(given);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const target = process.env.MAGNUM_TARGET_URL;
    if (target) config.baseUrl = target;
    config.__path = path.relative(process.cwd(), configPath);
    return { config, configPath };
  } catch (_) {
    return { config: null, configPath: null };
  }
}

async function commandDoctor(args) {
  const { config, configPath } = loadConfigIfPresent(args.config);
  const result = await doctor({ config, configPath });
  return result.ok ? 0 : 1;
}

async function commandValidate(args) {
  const { config, configPath } = loadConfigIfPresent(args.config);
  if (!config) {
    console.error(
      'No config file found. Run "magnum-opus init" first, or pass --config <path>.'
    );
    return 1;
  }
  if (args.target) config.baseUrl = args.target;
  const result = await validate({
    config,
    configPath,
    acknowledged: args['i-know-this-is-not-production'] === true
  });
  return result.ok ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let code = 0;

  try {
    switch (args.command) {
      case 'init':
        init({
          dir: args.dir || 'magnum',
          domain: args.domain || null,
          force: args.force === true
        });
        break;
      case 'generate':
        if (!args.spec) {
          console.error('generate requires --spec <path to openapi.json>');
          code = 1;
          break;
        }
        generate({ specPath: args.spec, outDir: args.out || 'magnum/personas', name: args.name });
        break;
      case 'setup':
        code = await commandSetup(args);
        break;
      case 'doctor':
        code = await commandDoctor(args);
        break;
      case 'validate':
        code = await commandValidate(args);
        break;
      case 'run':
        code = await commandRun(args);
        break;
      case 'report':
        code = await commandReport(args);
        break;
      case 'diff':
        code = await commandDiff(args);
        break;
      default:
        console.log(USAGE);
        code = args.command ? 1 : 0;
    }
  } catch (err) {
    if (err.code === 'MAGNUM_UNSAFE_TARGET') {
      console.error(`\n${err.message}\n`);
      code = 3;
    } else if (err.code === 'MAGNUM_USER_ERROR') {
      console.error(`\n${err.message}\n`);
      code = 1;
    } else {
      console.error('\nFailed:', err.magnumHint || err.message);
      if (!err.magnumHint && err.stack) console.error(err.stack);
      code = 2;
    }
  }

  await closePool().catch(() => {});
  process.exit(code);
}

if (require.main === module) main();

module.exports = { main, parseArgs, exitCodeFor, printReport, resolveConfigPath };
