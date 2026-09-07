'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persona loading.
 *
 * Phase 1.5 hardcoded require() calls to three files inside the package,
 * which made the tool unusable as a dependency: your personas describe YOUR
 * endpoints and belong in YOUR repository, versioned alongside the code they
 * test. Personas are now read from a directory you configure.
 *
 * Resolution order:
 *   1. config.personasDir, resolved against the config file's own location
 *   2. ./magnum/personas relative to the working directory
 *   3. the packaged built-ins (so the bundled demo still runs)
 */
const BUILTIN_DIR = path.join(__dirname, 'definitions');

function validatePersona(persona, source) {
  const problems = [];
  if (!persona.persona) problems.push('missing "persona" name');
  if (!Array.isArray(persona.states) || persona.states.length === 0) {
    problems.push('missing "states"');
  } else {
    const names = new Set(persona.states.map((s) => s.name));
    if (!persona.states.some((s) => s.terminal)) problems.push('no terminal state');
    for (const state of persona.states) {
      for (const t of state.transitions || []) {
        if (!names.has(t.to)) {
          problems.push(`state "${state.name}" transitions to unknown state "${t.to}"`);
        }
      }
      if (!state.terminal && (!state.transitions || state.transitions.length === 0)) {
        problems.push(`non-terminal state "${state.name}" has no transitions`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid persona in ${source}:\n  - ${problems.join('\n  - ')}`);
  }
  return persona;
}

function loadFromDir(dir) {
  const personas = {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const full = path.join(dir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse persona ${full}: ${err.message}`);
    }
    validatePersona(parsed, full);
    if (personas[parsed.persona]) {
      throw new Error(`Duplicate persona name "${parsed.persona}" in ${full}`);
    }
    personas[parsed.persona] = parsed;
  }
  return personas;
}

/**
 * @param {object} config       the parsed config file
 * @param {string} configPath   path to that file, for relative resolution
 * @param {string} cwd          working directory
 */
function loadPersonas({ config = {}, configPath = null, cwd = process.cwd() } = {}) {
  // A default parameter only fills in `undefined`. Callers that legitimately
  // have no config yet — doctor on a first run — pass null explicitly, which
  // would otherwise crash here on the very path meant to diagnose that state.
  const settings = config || {};
  const candidates = [];

  if (settings.personasDir) {
    const base = configPath ? path.dirname(path.resolve(configPath)) : cwd;
    candidates.push(path.resolve(base, settings.personasDir));
  }
  candidates.push(path.resolve(cwd, 'magnum/personas'));
  candidates.push(BUILTIN_DIR);

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const personas = loadFromDir(dir);
    if (Object.keys(personas).length > 0) {
      return { personas, source: dir, isBuiltin: dir === BUILTIN_DIR };
    }
  }

  throw new Error(
    `No personas found. Looked in:\n  ${candidates.join('\n  ')}\n\n` +
      `Run "npx magnum-opus init" to scaffold a magnum/ directory with templates.`
  );
}

/** Fail early with a clear message rather than mid-run. */
function assertMixIsLoadable(personaMix, personas, source) {
  const missing = Object.keys(personaMix).filter((name) => !personas[name]);
  if (missing.length > 0) {
    throw new Error(
      `Config references persona(s) not found in ${source}:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\n\nAvailable: ${Object.keys(personas).join(', ') || '(none)'}`
    );
  }
}

module.exports = { loadPersonas, loadFromDir, validatePersona, assertMixIsLoadable, BUILTIN_DIR };
