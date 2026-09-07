'use strict';

/**
 * SARIF 2.1.0 output for GitHub code scanning.
 *
 * Findings are not tied to a source line — they are behavioural, observed at
 * runtime. SARIF requires a location, so each result is anchored to the
 * config file that produced the run. Reviewers get the finding in the
 * Security tab; the detail lives in the message and properties.
 */
const LEVEL = { critical: 'error', warning: 'warning', info: 'note' };

function toSarif({ findings, config, configPath = 'magnum/config.json', seed, runId }) {
  const detectors = [...new Set(findings.map((f) => f.detector))];

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Magnum Opus',
            informationUri: 'https://github.com/sagheerplus/magnum-opus',
            rules: detectors.map((d) => ({
              id: d,
              name: d,
              shortDescription: { text: RULE_TEXT[d]?.short || d },
              fullDescription: { text: RULE_TEXT[d]?.full || RULE_TEXT[d]?.short || d },
              defaultConfiguration: { level: 'error' }
            }))
          }
        },
        automationDetails: { id: `magnum-opus/${seed}`, description: { text: `run ${runId}` } },
        results: findings
          .filter((f) => f.severity !== 'info')
          .map((f) => ({
            ruleId: f.detector,
            level: LEVEL[f.severity] || 'warning',
            message: { text: f.summary },
            partialFingerprints: { magnumOpus: f.fingerprint },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: configPath.replace(/\\/g, '/') },
                  region: { startLine: 1 }
                }
              }
            ],
            properties: {
              seed,
              runId,
              target: config?.baseUrl,
              evidenceTraceIds: f.evidence_trace_ids || []
            }
          }))
      }
    ]
  };
}

const RULE_TEXT = {
  duplicateWrites: {
    short: 'Non-idempotent write under client retry',
    full: 'A single logical intent produced more than one record when the client abandoned and retried.'
  },
  isolation: {
    short: 'Cross-actor data leak',
    full: "A response served one actor data belonging to another actor's session."
  },
  invariantViolations: {
    short: 'Declared invariant violated',
    full: 'A business invariant declared in the persona did not hold after the run settled.'
  },
  errorSpikes: { short: 'Elevated error or timeout rate' },
  abandonmentRate: { short: 'Elevated flow abandonment' }
};

module.exports = { toSarif };
