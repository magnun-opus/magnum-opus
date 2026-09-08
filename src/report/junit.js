'use strict';

/**
 * JUnit XML for CI systems that read test reports.
 *
 * Mapping: one testsuite per detector, one testcase per finding. Info-level
 * findings become passing cases, so a green report still shows what was
 * actively verified rather than an empty file.
 */
function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toJUnit({ findings, seed, runId, durationSeconds = 0 }) {
  const byDetector = new Map();
  for (const f of findings) {
    if (!byDetector.has(f.detector)) byDetector.set(f.detector, []);
    byDetector.get(f.detector).push(f);
  }

  const failures = findings.filter((f) => f.severity !== 'info').length;

  const suites = [...byDetector.entries()]
    .map(([detector, group]) => {
      const cases = group
        .map((f) => {
          const name = escape(f.signature?.action || f.signature?.invariant || f.fingerprint);
          if (f.severity === 'info') {
            return `    <testcase classname="${escape(detector)}" name="${name}" />`;
          }
          const type = f.severity === 'critical' ? 'failure' : 'warning';
          return (
            `    <testcase classname="${escape(detector)}" name="${name}">\n` +
            `      <${type} message="${escape(f.summary)}">${escape(
              JSON.stringify(f.evidence || {}, null, 2)
            )}</${type}>\n` +
            `    </testcase>`
          );
        })
        .join('\n');

      const suiteFailures = group.filter((f) => f.severity !== 'info').length;
      return (
        `  <testsuite name="${escape(detector)}" tests="${group.length}" ` +
        `failures="${suiteFailures}">\n${cases}\n  </testsuite>`
      );
    })
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="Magnum Opus ${escape(seed)}" tests="${findings.length}" ` +
    `failures="${failures}" time="${durationSeconds}">\n` +
    `${suites}\n</testsuites>\n`
  );
}

module.exports = { toJUnit };
