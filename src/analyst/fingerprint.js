'use strict';

const crypto = require('crypto');

/**
 * A finding's identity across runs.
 *
 * Diffing two runs requires findings that are recognisable when counts and
 * trace ids differ. So a fingerprint is computed from the SIGNATURE a
 * detector declares — detector name, endpoint, violation kind — and never
 * from anything that varies with load: no counts, no percentages, no ids.
 *
 *   fingerprint = sha256(canonicalJson(signature)).slice(0, 16)
 *
 * "POST /checkout is not idempotent" must fingerprint identically whether it
 * affected 14 actors or 18, or the diff is meaningless.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function fingerprint(signature) {
  return crypto.createHash('sha256').update(canonical(signature)).digest('hex').slice(0, 16);
}

/** Attach fingerprints to a batch of findings, deriving a fallback if needed. */
function applyFingerprints(findings) {
  for (const f of findings) {
    const signature = f.signature || { detector: f.detector, summary: f.summary };
    f.fingerprint = fingerprint(signature);
  }
  return findings;
}

module.exports = { fingerprint, applyFingerprints, canonical };
