'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Scaffolds a magnum/ directory in the consumer's project.
 *
 * Personas belong in YOUR repository, versioned alongside the endpoints they
 * exercise — they change when your API changes. This writes a working
 * template rather than an empty file, because the persona format is the part
 * that actually takes learning.
 *
 * Never overwrites: an existing file is reported and skipped.
 */
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const DOMAIN_DIR = path.join(TEMPLATE_DIR, 'domains');

/** Domain packs ship the half of a persona that is genuinely hard: the
 *  journey, the failure branches, and the invariants that matter in that
 *  business. Endpoints and field names are the easy half — rename those. */
/** An error caused by how the command was used, not by a fault. The CLI
 *  prints these without a stack trace — a stack is noise when the message
 *  already says exactly what to do. */
function userError(message) {
  const err = new Error(message);
  err.code = 'MAGNUM_USER_ERROR';
  return err;
}

function listDomains() {
  if (!fs.existsSync(DOMAIN_DIR)) return [];
  return fs.readdirSync(DOMAIN_DIR).filter((d) =>
    fs.existsSync(path.join(DOMAIN_DIR, d, 'config.json'))
  );
}

function copyTree(from, to, written, skipped) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest, written, skipped);
    else copyIfAbsent(src, dest, written, skipped);
  }
}

function copyIfAbsent(from, to, written, skipped) {
  if (fs.existsSync(to)) {
    skipped.push(to);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  written.push(to);
}

function init({ cwd = process.cwd(), dir = 'magnum', domain = null, force = false } = {}) {
  const target = path.resolve(cwd, dir);
  const written = [];
  const skipped = [];
  const domains = listDomains();

  if (domain) {
    if (!domains.includes(domain)) {
      throw userError(`Unknown domain "${domain}".\nAvailable: ${domains.join(', ')}`);
    }

    // Never overwriting is right for safety, but it makes switching domains
    // silently wrong: the new personas land while config.json keeps pointing
    // at the old ones, so the run uses the previous domain's personaMix and
    // invariants. Detect that and say so, rather than reporting "exists" and
    // leaving a mismatched project behind.
    const configPath = path.join(target, 'config.json');
    if (fs.existsSync(configPath) && !force) {
      let existingDomain = null;
      try {
        existingDomain = JSON.parse(fs.readFileSync(configPath, 'utf8'))._domain || null;
      } catch (_) {
        /* unreadable config is handled the same way */
      }
      if (existingDomain !== domain) {
        throw userError(
          `${path.relative(cwd, configPath)} already exists and is ` +
            `${existingDomain ? `for the "${existingDomain}" domain` : 'not a domain config'}, ` +
            `not "${domain}".\n\n` +
            `Copying the ${domain} personas alongside it would leave the project\n` +
            `mismatched: the personas would be ${domain}, but personaMix and the\n` +
            `invariants would still be the old ones.\n\n` +
            `Either:\n` +
            `  magnum-opus init --domain ${domain} --force     overwrite config.json\n` +
            `  magnum-opus init --domain ${domain} --dir magnum-${domain}   scaffold beside it`
        );
      }
    }

    if (force && fs.existsSync(configPath)) fs.rmSync(configPath);
    copyTree(path.join(DOMAIN_DIR, domain), target, written, skipped);

    // Personas left over from another domain are unused once personaMix is
    // right, but they are confusing clutter — name them so they can go.
    const personaDir = path.join(target, 'personas');
    if (fs.existsSync(personaDir)) {
      const shipped = new Set(fs.readdirSync(path.join(DOMAIN_DIR, domain, 'personas')));
      const orphans = fs.readdirSync(personaDir).filter((f) => f.endsWith('.json') && !shipped.has(f));
      if (orphans.length > 0) {
        console.log(`\n  Left over from a previous scaffold (safe to delete):`);
        for (const o of orphans) console.log(`    ${path.relative(cwd, path.join(personaDir, o))}`);
      }
    }
  } else {
    copyIfAbsent(path.join(TEMPLATE_DIR, 'config.json'), path.join(target, 'config.json'), written, skipped);
    copyIfAbsent(
      path.join(TEMPLATE_DIR, 'personas', 'exampleCustomer.json'),
      path.join(target, 'personas', 'exampleCustomer.json'),
      written,
      skipped
    );
  }

  const rel = (p) => path.relative(cwd, p).replace(/\\/g, '/');

  console.log(`\nMagnum Opus — project scaffold${domain ? ` (${domain})` : ''}\n`);
  for (const f of written) console.log(`  created  ${rel(f)}`);
  for (const f of skipped) console.log(`  exists   ${rel(f)}  (left untouched)`);

  if (!domain && domains.length > 0) {
    console.log(`\n  Domain packs available: ${domains.join(', ')}`);
    console.log(`  Start closer to your app:  magnum-opus init --domain ${domains[0]}`);
  }

  console.log(`
Next steps:

  1. Point ${rel(path.join(target, 'config.json'))} at your app:
       "baseUrl": "http://localhost:3000"

  2. Rewrite ${rel(path.join(target, 'personas'))}/exampleCustomer.json to describe
     a real flow in your application. The parts that matter:
       - "action"     the endpoints your app actually exposes
       - "intent"     mark the state that performs the write you care about
       - "probes"     a read-back endpoint so invariants have something to check
       - "invariants" the business truths that must hold

  3. Set MAGNUM_OPUS_DB_URL in .env, then:
       npx magnum-opus setup
       npx magnum-opus run --config ${rel(path.join(target, 'config.json'))}
`);

  return { written, skipped, target, domain };
}

module.exports = { init };
