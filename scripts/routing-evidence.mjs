import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { taskEvidence, cohortSummary, correlate } from '../dist/agent/evidence.js';
import { validateRunState, validateLedger } from '../dist/schema/validate.js';
import { loadEnv } from '../dist/engine/env.js';
import { NeatlogsWorkerTraceReader } from '../dist/adapters/neatlogs-worker-traces.js';

const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
if (args.includes('--help') || !option('--manifest') || !option('--out')) {
  console.log('Usage: npm run build, then node scripts/routing-evidence.mjs --manifest runs.json --out <directory> [--issues issues.json] [--live-traces]');
  console.log('Manifest: an audited JSON array of real run directories. Without --live-traces the cached trace-readback.json is replayed with no API calls.');
  process.exit(args.includes('--help') ? 0 : 1);
}
const out = resolve(option('--out'));
const manifest = JSON.parse(await readFile(resolve(option('--manifest')), 'utf8'));
if (!Array.isArray(manifest) || manifest.some(value => typeof value !== 'string')) throw new Error('Manifest must be an array of audited run-directory paths.');
const issuesPath = option('--issues');
const issues = issuesPath ? JSON.parse(await readFile(resolve(issuesPath), 'utf8')) : {};
await mkdir(out, { recursive: true });
const seen = new Set(), tasks = [], attempts = [], exclusions = [], sources = [];
for (const entry of manifest) {
  const path = await realpath(entry);
  const run = JSON.parse(await readFile(join(path, 'run.json'), 'utf8'));
  const ledger = JSON.parse(await readFile(join(path, 'ledger.json'), 'utf8'));
  if (path.includes('/fixtures/') || seen.has(run.runId) || run.dryRun !== false || run.status === 'running') {
    exclusions.push({ path, reason: 'fixture, duplicate, dry run or active run' }); continue;
  }
  const errors = [...validateRunState(run).errors, ...validateLedger(ledger).errors];
  if (errors.length) { exclusions.push({ path, reason: 'schema validation failed', errors }); continue; }
  seen.add(run.runId);
  const rows = taskEvidence(run, ledger, path, issues);
  tasks.push(...rows); sources.push({ runId: run.runId, path, mode: run.mode, repo: run.repo });
  attempts.push(...ledger.filter(row => row.runId === run.runId && row.costSource !== 'simulated' && !row.attemptId.endsWith(':handoff')));
}

let readback = { retrievedAt: null, history: [], workers: [], truncated: false, errors: [] };
if (args.includes('--live-traces')) {
  const env = loadEnv();
  if (!env.NEATLOGS_TOKEN || !env.NEATLOGS_PROJECT_ID) throw new Error('Read-only trace verification needs NEATLOGS_TOKEN and NEATLOGS_PROJECT_ID in ~/.tally/.env.');
  const headers = { Authorization: `Bearer ${env.NEATLOGS_TOKEN}`, 'x-project-id': env.NEATLOGS_PROJECT_ID };
  const endpoint = 'https://app.neatlogs.com/api/v1/public';
  const read = async path => {
    const response = await fetch(`${endpoint}${path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Neatlogs read HTTP ${response.status}`);
    return (await response.json()).data;
  };
  let cursor;
  const cursors = new Set();
  try {
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ workflowName: 'tally-cfo-agent', limit: '50', ...(cursor ? { cursor } : {}) });
      const body = await read(`/traces?${query}`);
      for (const trace of body.traces ?? []) {
        const name = trace.traceName ?? '';
        if (!name.startsWith('tally.history.record ')) continue;
        const fields = Object.fromEntries(name.slice('tally.history.record '.length).split(/\s+/).map(part => part.split('=')).filter(parts => parts.length === 2));
        const costNanos = Number(fields.cost_nanos);
        if (!Number.isSafeInteger(costNanos) || costNanos < 0) continue;
        readback.history.push({ traceId: trace.traceId, runId: trace.sessionId, size: fields.size, tier: fields.tier,
          result: fields.result, costNanos, startedAt: trace.startedAt });
      }
      readback.truncated = body.page?.hasMore === true;
      if (!body.page?.hasMore || !body.page?.nextCursor) break;
      cursor = body.page.nextCursor;
      if (cursors.has(cursor)) throw new Error('Trace pagination repeated a cursor');
      cursors.add(cursor);
    }
  } catch (error) { readback.errors.push(error.message); }
  const reader = new NeatlogsWorkerTraceReader({ env, retries: 1 });
  for (const row of attempts) {
    if (!row.workerTraceId) continue;
    try {
      const id = await reader.verifyFor({ runId: row.runId, taskId: row.taskId, attempt: row.attempt, traceId: row.workerTraceId });
      const metadata = id ? await read(`/traces/${id}`) : null;
      readback.workers.push({ attemptId: row.attemptId, traceId: row.workerTraceId, verified: id !== null,
        totalCostUsd: metadata?.totalCostUsd ?? null, totalTokens: metadata?.totalTokens ?? null, spans: metadata?.spansCount ?? null });
    } catch { readback.workers.push({ attemptId: row.attemptId, traceId: row.workerTraceId, verified: false }); }
  }
  readback.retrievedAt = new Date().toISOString();
  await writeFile(join(out, 'trace-readback.json'), JSON.stringify(readback, null, 2) + '\n');
} else {
  try { readback = JSON.parse(await readFile(join(out, 'trace-readback.json'), 'utf8')); } catch { /* Explicitly report no readback, never fabricate it. */ }
}

const cohorts = ['prior-only', 'trace-driven', 'local-history', 'unattributed', 'baseline'].map(group => cohortSummary(tasks, group));
const eligible = tasks.filter(task => task.passed && !task.errored);
const signals = [
  ['graphNodes', 'Entire graph nodes'], ['filesTouched', 'Predicted target files'],
  ['issueLength', 'Issue-text characters'], ['filesNamed', 'Path-like file mentions'],
].map(([key, label]) => ({ key, label, ...correlate(eligible.map(task => [task[key], task.costNanos / 1e9])) }));
const matched = attempts.filter(row => readback.history.some(history => history.runId === row.runId && history.size === row.size
  && history.tier === row.tier && history.result === row.result && history.costNanos === row.estimatedCostNanos));
const reportData = { generatedAt: new Date().toISOString(), sources, exclusions, cohorts, signals, tasks,
  traceReadback: { retrievedAt: readback.retrievedAt, matchedHistoryAttempts: matched.length,
    verifiedWorkers: attempts.filter(row => readback.workers.some(worker => worker.attemptId === row.attemptId && worker.traceId === row.workerTraceId && worker.verified)).length,
    availableWorkerIds: attempts.filter(row => row.workerTraceId).length,
    historyWindowTruncated: readback.truncated, errors: readback.errors } };
await writeFile(join(out, 'results.json'), JSON.stringify(reportData, null, 2) + '\n');
const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const keys = ['runId', 'repo', 'taskId', 'cohort', 'costNanos', 'passed', 'errored', 'skipped', 'attempts', 'size', 'graphNodes', 'filesTouched', 'issueLength', 'filesNamed', 'textSource', 'models', 'source'];
await writeFile(join(out, 'tasks.csv'), [keys.join(','), ...tasks.map(task => keys.map(key => csv(task[key])).join(','))].join('\n') + '\n');

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const svg = (title, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-label="${escape(title)}"><rect width="960" height="${height}" fill="#fff"/><style>text{font-family:Arial,sans-serif;fill:#222;font-size:15px}</style><text x="24" y="32" font-size="22">${escape(title)}</text>${body}</svg>\n`;
async function barChart(file, title, key, format) {
  const max = Math.max(...cohorts.map(row => row[key] ?? 0), 0.01);
  const body = cohorts.map((row, i) => {
    const y = 72 + i * 54, value = row[key];
    return `<text x="24" y="${y + 17}">${escape(row.cohort)} (n=${row.tasks})</text>${value === null
      ? `<text x="280" y="${y + 17}">Not measured</text>`
      : `<rect x="260" y="${y}" width="${Math.max(1, value / max * 470)}" height="26" fill="${i === 1 ? '#187d5b' : '#356bbb'}"/><text x="750" y="${y + 17}">${escape(format(value))}</text>`}`;
  }).join('');
  await writeFile(join(out, file), svg(title, 390, body + '<text x="24" y="365">Observed task executions; different repos, models and setup histories. Not a causal savings comparison.</text>'));
}
await barChart('cost-by-routing.svg', 'Mean estimated list-price cost per task execution', 'meanCostUsd', value => `$${value.toFixed(4)}`);
await barChart('success-by-routing.svg', 'Observed task pass rate (including operational failures)', 'successRate', value => `${(value * 100).toFixed(1)}%`);
const scatter = signals.map((signal, i) => {
  const x0 = 65 + (i % 2) * 470, y0 = 100 + Math.floor(i / 2) * 280;
  const rows = eligible.filter(row => row[signal.key] !== null);
  const maxX = Math.max(...rows.map(row => row[signal.key]), 1), maxY = Math.max(...rows.map(row => row.costNanos / 1e9), 0.01);
  const points = rows.map(row => `<circle cx="${x0 + row[signal.key] / maxX * 330}" cy="${y0 + 180 - row.costNanos / 1e9 / maxY * 165}" r="4" fill="#187d5b"><title>${escape(`${row.runId}/${row.taskId}, $${(row.costNanos / 1e9).toFixed(5)}`)}</title></circle>`).join('');
  return `<text x="${x0}" y="${y0 - 30}">${escape(signal.label)}: n=${signal.n}, Pearson ${signal.pearson === null ? 'n/a' : signal.pearson.toFixed(2)}</text><path d="M${x0} ${y0}v180h340" stroke="#888" fill="none"/>${points}<text x="${x0}" y="${y0 + 205}">0</text><text x="${x0 + 280}" y="${y0 + 205}">${maxX.toFixed(0)}</text><text x="${x0}" y="${y0 - 8}">$${maxY.toFixed(3)}</text>`;
}).join('');
await writeFile(join(out, 'size-cost.svg'), svg('Sizing signals versus completed-task estimated cost', 650, scatter + '<text x="24" y="625">Successful task executions only; small, selected sample. Text may be reconstructed from current issue bodies.</text>'));

const fmt = value => value === null ? 'not measured' : value.toFixed(3);
const lines = [
  '# Routing evidence', '', `Generated ${reportData.generatedAt}. ${sources.length} closed real runs; ${tasks.length} task outcomes (including skipped).`, '',
  '## Before and after', '',
  '| Routing evidence | Task outcomes | Passed | Operational errors | Skipped | Mean cost (USD) | Pass rate |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...cohorts.map(row => `| ${row.cohort} | ${row.tasks} | ${row.passed} | ${row.errors} | ${row.skipped} | ${row.meanCostUsd === null ? 'not measured' : row.meanCostUsd.toFixed(5)} | ${row.successRate === null ? 'not measured' : (row.successRate * 100).toFixed(1) + '%'} |`), '',
  '![Estimated cost by routing](cost-by-routing.svg)', '', '![Success rate by routing](success-by-routing.svg)', '',
  'Prior-only requires an explicit prior statement for the chosen tier. Trace-driven requires explicit neatlogs provenance and an observed P90 cap for the chosen tier. Old ambiguous decisions are unattributed, not silently assigned to either group.', '',
  'No v1/v2 savings claim or baseline comparison is valid until both have measured, matched tasks. Missing cohorts mean not measured, never zero cost or 0% success. Closed interrupted runs and skipped tasks stay in the denominator; zero spend on an unstarted task is not savings. Repeated issues across runs are not independent experiments.', '',
  '## Does sizing predict cost?', '',
  '| Signal | Paired successful tasks | Pearson r | Spearman rho | Interpretation |', '|---|---:|---:|---:|---|',
  ...signals.map(signal => `| ${signal.label} | ${signal.n} | ${fmt(signal.pearson)} | ${fmt(signal.spearman)} | ${signal.interpretation} |`), '',
  '![Sizing signals against estimated cost](size-cost.svg)', '',
  'Graph nodes and target-file counts come only from saved impact totals; missing historical graphs are not reconstructed or replaced with actual edited files. Current issue bodies are labelled current-issue, not run-start snapshots. Most successful tasks are small documentation changes. Model price, caching, setup and repository differences confound these correlations; do not use them to train or claim a general cost predictor.', '',
  '## Trace readback', '',
  `Readback date: ${readback.retrievedAt ?? 'not performed'}. ${matched.length}/${attempts.length} attempt costs/outcomes match a neatlogs history record by run, size, tier, result and integer cost.`,
  `${reportData.traceReadback.verifiedWorkers}/${reportData.traceReadback.availableWorkerIds} stored worker trace IDs verified by correlated metadata plus readable spans. Window truncated: ${readback.truncated}.`,
  'Costs here are normalized list-price/AO estimates from the real ledger, not invoices. History trace names repeat those recorded estimates. Public worker traces can report zero cost/tokens when hooks export tool activity only; that does not mean the worker was free.', '',
  '## Replay and limits', '',
  'The audited input paths are in sources.json; task-level data is in tasks.csv and results.json. trace-readback.json caches actual read results. Re-running without --live-traces makes no API call. No paid workers, cfo.ai writes, or fabricated baseline runs were used.',
  `Schema/exclusion count: ${exclusions.length}. Read errors: ${readback.errors.length}.`,
];
await writeFile(join(out, 'sources.json'), JSON.stringify(sources.map(source => source.path), null, 2) + '\n');
await writeFile(join(out, 'report.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ output: out, runs: sources.length, tasks: tasks.length, cohorts, signals, traceReadback: reportData.traceReadback }, null, 2));
