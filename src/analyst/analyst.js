'use strict';

const { query } = require('../db/client');
const { detectDuplicateWrites } = require('./detectors/duplicateWrites');
const { detectErrorSpikes } = require('./detectors/errorSpikes');
const { detectAbandonmentRate } = require('./detectors/abandonmentRate');
const { detectInvariantViolations } = require('./detectors/invariantViolations');
const { detectIsolation } = require('./detectors/isolation');
const { detectTemporalDegradation } = require('./detectors/temporalDegradation');
const { applyFingerprints } = require('./fingerprint');

/**
 * Detector registry. Each entry receives (runId, optionsForThisDetector).
 * Thresholds come from config.detectors.<name>, so tuning an application's
 * tolerance never means editing source.
 */
const DETECTORS = {
  isolation: detectIsolation,
  duplicateWrites: detectDuplicateWrites,
  invariantViolations: detectInvariantViolations,
  temporalDegradation: detectTemporalDegradation,
  errorSpikes: detectErrorSpikes,
  abandonmentRate: detectAbandonmentRate
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

async function analyze(runId, config = {}) {
  const detectorConfig = config.detectors || {};
  const allFindings = [];

  for (const [name, detector] of Object.entries(DETECTORS)) {
    const options = detectorConfig[name] || {};
    if (options.enabled === false) continue;
    try {
      const findings = await detector(runId, options);
      allFindings.push(...findings);
    } catch (err) {
      console.error(`Detector ${name} failed: ${err.message}`);
    }
  }

  // Fingerprints must exist before persistence: they are the key that makes
  // two runs comparable.
  applyFingerprints(allFindings);

  allFindings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.detector.localeCompare(b.detector)
  );

  for (const f of allFindings) {
    await query(
      `INSERT INTO findings (finding_id, run_id, severity, detector, summary, evidence_trace_ids, evidence, fingerprint, signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        f.finding_id,
        f.run_id,
        f.severity,
        f.detector,
        f.summary,
        f.evidence_trace_ids || [],
        f.evidence ? JSON.stringify(f.evidence) : null,
        f.fingerprint,
        f.signature ? JSON.stringify(f.signature) : null
      ]
    );
  }

  return allFindings;
}

module.exports = { analyze, DETECTORS, SEVERITY_ORDER };
