'use strict';

const { query } = require('../db/client');

/**
 * Self-contained HTML report.
 *
 * Deliberately a single file with everything inlined rather than a served
 * dashboard: it works offline, attaches to a pull request, needs no
 * dependency, and adds no listening port to a tool whose safety story
 * depends on having a small surface.
 *
 * The centrepiece is the trace timeline, not the charts. A summary tells you
 * a duplicate happened; the timeline lets you watch it happen — request,
 * client gives up, retry, then the original response arriving late with a
 * different record id. That sequence is what makes a finding believable
 * enough to act on.
 */

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function gather(runId) {
  const [run, findings, events, endpoints, epochs, actors] = await Promise.all([
    query(`SELECT run_id, seed, config, started_at, ended_at, status FROM simulation_runs WHERE run_id = $1`, [runId]),
    query(
      `SELECT severity, detector, summary, evidence_trace_ids, evidence, fingerprint
         FROM findings WHERE run_id = $1`,
      [runId]
    ),
    query(
      `SELECT trace_id, trace_sequence, event_type, action, outcome, latency_ms,
              http_status, attempt_number, idempotency_key, payload, epoch
         FROM events WHERE run_id = $1 ORDER BY trace_id, trace_sequence`,
      [runId]
    ),
    query(
      `SELECT split_part(action, '?', 1) AS endpoint,
              count(*) AS calls,
              count(*) FILTER (WHERE outcome = 'success') AS ok,
              count(*) FILTER (WHERE outcome = 'timeout') AS timeouts,
              count(*) FILTER (WHERE outcome = 'error')   AS errors,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)) AS p50,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)) AS p95,
              max(latency_ms) AS worst
         FROM events
        WHERE run_id = $1 AND event_type IN ('http_request','probe','auth','late_response')
        GROUP BY 1 ORDER BY calls DESC`,
      [runId]
    ),
    query(
      `SELECT epoch, split_part(action,'?',1) AS endpoint,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)) AS p95
         FROM events
        WHERE run_id = $1 AND epoch > 0 AND outcome = 'success' AND latency_ms IS NOT NULL
        GROUP BY 1,2 ORDER BY 2,1`,
      [runId]
    ),
    query(
      `SELECT persona_type, count(*) AS actors FROM actors WHERE run_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
      [runId]
    )
  ]);

  if (run.rows.length === 0) throw new Error(`No run found with id ${runId}`);
  return {
    run: run.rows[0],
    findings: run.rows.length ? findings.rows : [],
    events: events.rows,
    endpoints: endpoints.rows,
    epochs: epochs.rows,
    actors: actors.rows
  };
}

/**
 * Which traces to show.
 *
 * Traces cited as evidence come first — those are the ones a reader needs.
 * A few clean traces follow for contrast, because a report showing only
 * failures gives no sense of what normal looks like.
 */
function selectTraces(findings, events, limit = 12) {
  const byTrace = new Map();
  for (const e of events) {
    if (!byTrace.has(e.trace_id)) byTrace.set(e.trace_id, []);
    byTrace.get(e.trace_id).push(e);
  }

  const cited = [];
  for (const f of findings) {
    for (const id of f.evidence_trace_ids || []) {
      if (byTrace.has(id) && !cited.includes(id)) cited.push(id);
    }
  }

  const interesting = [...byTrace.keys()].filter(
    (id) =>
      !cited.includes(id) &&
      byTrace.get(id).some((e) => e.outcome === 'timeout' || e.event_type === 'late_response')
  );

  const clean = [...byTrace.keys()].filter(
    (id) => !cited.includes(id) && !interesting.includes(id)
  );

  const chosen = [...cited, ...interesting, ...clean].slice(0, limit);
  return chosen.map((id) => ({ id, events: byTrace.get(id), cited: cited.includes(id) }));
}

const OUTCOME_CLASS = {
  success: 'ok',
  held: 'ok',
  match: 'ok',
  timeout: 'warn',
  no_response: 'warn',
  skipped: 'warn',
  abandon: 'warn',
  error: 'bad',
  violated: 'bad',
  mismatch: 'bad',
  abandoned: 'bad'
};

function renderTimeline(trace) {
  const rows = trace.events
    .map((e) => {
      const cls = OUTCOME_CLASS[e.outcome] || 'neutral';
      const meta = [
        e.http_status ? `HTTP ${e.http_status}` : null,
        e.latency_ms != null ? `${e.latency_ms}ms` : null,
        e.attempt_number ? `attempt ${e.attempt_number}` : null
      ]
        .filter(Boolean)
        .join(' · ');

      const payload = e.payload ? JSON.stringify(e.payload, null, 2) : null;

      return `
      <li class="ev ${cls}">
        <span class="tag">${esc(e.event_type)}</span>
        <span class="act">${esc(e.action)}</span>
        <span class="meta">${esc(meta)}</span>
        ${payload ? `<details><summary>payload</summary><pre>${esc(payload)}</pre></details>` : ''}
      </li>`;
    })
    .join('');

  return `
    <details class="trace"${trace.cited ? ' open' : ''}>
      <summary>
        <code>${esc(trace.id.slice(0, 8))}</code>
        ${trace.cited ? '<span class="badge">cited as evidence</span>' : ''}
        <span class="meta">${trace.events.length} events</span>
      </summary>
      <ol class="timeline">${rows}</ol>
    </details>`;
}

/** Inline SVG line chart — no charting library, no network fetch. */
function renderEpochChart(epochs) {
  if (epochs.length === 0) return '';

  const byEndpoint = new Map();
  for (const r of epochs) {
    if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, []);
    byEndpoint.get(r.endpoint).push({ epoch: Number(r.epoch), p95: Number(r.p95) });
  }

  const allEpochs = [...new Set(epochs.map((r) => Number(r.epoch)))].sort((a, b) => a - b);
  const maxP95 = Math.max(...epochs.map((r) => Number(r.p95)), 1);
  const W = 640;
  const H = 220;
  const pad = 40;

  const x = (epoch) =>
    pad + ((epoch - allEpochs[0]) / Math.max(allEpochs.length - 1, 1)) * (W - pad * 2);
  const y = (p95) => H - pad - (p95 / maxP95) * (H - pad * 2);

  const colours = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed'];
  let i = 0;
  const series = [...byEndpoint.entries()]
    .map(([endpoint, points]) => {
      const colour = colours[i++ % colours.length];
      const path = points
        .sort((a, b) => a.epoch - b.epoch)
        .map((p, n) => `${n === 0 ? 'M' : 'L'}${x(p.epoch).toFixed(1)},${y(p.p95).toFixed(1)}`)
        .join(' ');
      const dots = points
        .map((p) => `<circle cx="${x(p.epoch).toFixed(1)}" cy="${y(p.p95).toFixed(1)}" r="3" fill="${colour}"/>`)
        .join('');
      return {
        svg: `<path d="${path}" fill="none" stroke="${colour}" stroke-width="2"/>${dots}`,
        legend: `<span class="key"><i style="background:${colour}"></i>${esc(endpoint)}</span>`
      };
    })
    .reduce((acc, s) => ({ svg: acc.svg + s.svg, legend: acc.legend + s.legend }), { svg: '', legend: '' });

  const ticks = allEpochs
    .map((e) => `<text x="${x(e).toFixed(1)}" y="${H - pad + 16}" text-anchor="middle" class="axis">${e}</text>`)
    .join('');

  return `
  <section>
    <h2>Latency as the world grows</h2>
    <p class="hint">p95 per endpoint, by epoch. A line that climbs with data volume
       is the signature of a scan where an index should be.</p>
    <svg viewBox="0 0 ${W} ${H}" class="chart">
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="axisline"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" class="axisline"/>
      <text x="${pad}" y="${pad - 12}" class="axis">${maxP95}ms</text>
      ${ticks}
      ${series.svg}
    </svg>
    <div class="legend">${series.legend}</div>
  </section>`;
}

function render(data) {
  const { run, findings, endpoints, epochs, actors } = data;
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const config = run.config || {};
  const traces = selectTraces(findings, data.events);

  const durationMs =
    run.ended_at && run.started_at ? new Date(run.ended_at) - new Date(run.started_at) : null;

  const findingHtml = sorted
    .map(
      (f) => `
    <article class="finding ${esc(f.severity)}">
      <header><span class="sev">${esc(f.severity)}</span><span class="det">${esc(f.detector)}</span></header>
      <p>${esc(f.summary)}</p>
      ${
        f.evidence
          ? `<details><summary>evidence</summary><pre>${esc(JSON.stringify(f.evidence, null, 2))}</pre></details>`
          : ''
      }
    </article>`
    )
    .join('');

  const endpointRows = endpoints
    .map(
      (e) => `<tr>
        <td><code>${esc(e.endpoint)}</code></td>
        <td class="num">${e.calls}</td>
        <td class="num">${e.ok}</td>
        <td class="num ${Number(e.timeouts) ? 'warn' : ''}">${e.timeouts}</td>
        <td class="num ${Number(e.errors) ? 'bad' : ''}">${e.errors}</td>
        <td class="num">${e.p50 ?? '—'}</td>
        <td class="num">${e.p95 ?? '—'}</td>
        <td class="num">${e.worst ?? '—'}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Magnum Opus — ${esc(run.seed || run.run_id)}</title>
<style>
  :root { --bad:#dc2626; --warn:#d97706; --ok:#059669; --line:#e5e7eb; --muted:#6b7280; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 0 20px 60px; color: #111827; background: #fff; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 28px 0 4px; }
  h2 { font-size: 17px; margin: 34px 0 8px; }
  .sub { color: var(--muted); margin: 0 0 18px; font-size: 13px; }
  .hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  .counts { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 6px; }
  .pill { border: 1px solid var(--line); border-radius: 6px; padding: 8px 14px; }
  .pill b { display: block; font-size: 20px; }
  .pill.critical b { color: var(--bad); } .pill.warning b { color: var(--warn); }
  .pill.info b { color: var(--ok); }
  .finding { border: 1px solid var(--line); border-left-width: 4px; border-radius: 6px;
             padding: 12px 14px; margin: 10px 0; }
  .finding.critical { border-left-color: var(--bad); }
  .finding.warning  { border-left-color: var(--warn); }
  .finding.info     { border-left-color: var(--ok); }
  .finding header { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
  .sev { text-transform: uppercase; font-size: 11px; letter-spacing: .06em; font-weight: 700; }
  .critical .sev { color: var(--bad); } .warning .sev { color: var(--warn); } .info .sev { color: var(--ok); }
  .det { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .finding p { margin: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.num.warn { color: var(--warn); } td.num.bad { color: var(--bad); }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
  pre { background: #f9fafb; border: 1px solid var(--line); border-radius: 5px;
        padding: 10px; overflow-x: auto; font-size: 12px; }
  details { margin-top: 6px; } summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  .trace { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
  .trace > summary { color: #111827; }
  .badge { background: #fef2f2; color: var(--bad); font-size: 11px; padding: 2px 7px;
           border-radius: 10px; margin-left: 6px; }
  .timeline { list-style: none; margin: 10px 0 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); }
  .ev { position: relative; padding: 6px 0 6px 14px; font-size: 13px; }
  .ev::before { content: ''; position: absolute; left: -7px; top: 13px; width: 10px; height: 10px;
                border-radius: 50%; background: var(--line); }
  .ev.ok::before { background: var(--ok); } .ev.warn::before { background: var(--warn); }
  .ev.bad::before { background: var(--bad); }
  .tag { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--muted);
         margin-right: 8px; }
  .act { font-family: ui-monospace, Menlo, monospace; }
  .meta { color: var(--muted); font-size: 12px; margin-left: 8px; }
  .chart { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
  .axis { font-size: 10px; fill: var(--muted); }
  .axisline { stroke: var(--line); }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; }
  .key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 12px;
           border-top: 1px solid var(--line); padding-top: 14px; }
</style></head>
<body><div class="wrap">

  <h1>Magnum Opus — simulation report</h1>
  <p class="sub">
    target <code>${esc(config.baseUrl || 'unknown')}</code> ·
    seed <code>${esc(run.seed || '—')}</code> ·
    ${durationMs != null ? `${(durationMs / 1000).toFixed(1)}s ·` : ''}
    run <code>${esc(run.run_id)}</code>
  </p>
  <p class="hint">Reproduce this run with <code>--seed ${esc(run.seed || '')}</code>.</p>

  <div class="counts">
    <div class="pill critical"><b>${count('critical')}</b>Critical</div>
    <div class="pill warning"><b>${count('warning')}</b>Warning</div>
    <div class="pill info"><b>${count('info')}</b>Info</div>
    <div class="pill"><b>${actors.reduce((n, a) => n + Number(a.actors), 0)}</b>Actors</div>
    <div class="pill"><b>${data.events.length}</b>Events</div>
  </div>

  <h2>Findings</h2>
  ${findingHtml || '<p class="hint">No findings from the enabled detectors.</p>'}

  <h2>Endpoints</h2>
  <table><thead><tr>
    <th>Endpoint</th><th class="num">Calls</th><th class="num">OK</th>
    <th class="num">Timeout</th><th class="num">Error</th>
    <th class="num">p50</th><th class="num">p95</th><th class="num">Max</th>
  </tr></thead><tbody>${endpointRows}</tbody></table>

  ${renderEpochChart(epochs)}

  <h2>Traces</h2>
  <p class="hint">Traces cited as evidence are open by default. This is where a finding
     stops being a claim: you can watch the client give up, retry, and the original
     request land afterwards.</p>
  ${traces.map(renderTimeline).join('')}

  <footer>
    Generated ${esc(new Date().toISOString())} · personas
    ${esc(actors.map((a) => `${a.persona_type} ×${a.actors}`).join(', '))}
  </footer>
</div></body></html>`;
}

async function buildHtmlReport(runId) {
  const data = await gather(runId);
  return { html: render(data), data };
}

module.exports = { buildHtmlReport, esc, selectTraces };
