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

function init({ cwd = process.cwd(), dir = 'magnum', domain = null } = {}) {
  const target = path.resolve(cwd, dir);
  const written = [];
  const skipped = [];
  const domains = listDomains();

  if (domain) {
    if (!domains.includes(domain)) {
      throw new Error(
        `Unknown domain "${domain}".\nAvailable: ${domains.join(', ')}`
      );
    }
    copyTree(path.join(DOMAIN_DIR, domain), target, written, skipped);
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
