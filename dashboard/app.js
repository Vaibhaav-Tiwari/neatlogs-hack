// Tally dashboard. Reads run.json and ledger.json on a timer and redraws.
// It never writes anything.

import { frameAt } from './replay-core.js';
import { displayedCost, isRunning, withLiveCosts } from './live-state.js';

const NANOS_PER_USD = 1_000_000_000;

const query = new URLSearchParams(location.search);
const defaults = window.TALLY_DASHBOARD ?? {};
const asFolder = (path) => (path.endsWith('/') ? path : `${path}/`);
const hasExplicitData = query.has('data');
const wantsDemo = query.has('demo');
const wantsReplay = query.has('replay');
const config = {
  data: asFolder(query.get('data') ?? defaults.data ?? './'),
  runsIndex: query.get('runsIndex') ?? defaults.runsIndex ?? '/runs/index.json',
  baseline: query.get('baseline') ?? defaults.baseline ?? null,
  intervalMs: Math.max(250, Number(query.get('interval') ?? defaults.intervalMs ?? 2000) || 2000),
  aoProject: query.get('aoProject') ?? defaults.aoProject ?? null,
  liveCeilingSec: Math.max(30, Number(query.get('liveCeilingSec') ?? defaults.liveCeilingSec ?? 180) || 180),
  sample: defaults.sample ?? null,
  // ?demo shows the checked-in sample. ?replay=60 plays the chosen run over that many seconds.
  useSample: wantsDemo || (wantsReplay && !hasExplicitData),
  replaySec: wantsReplay ? Math.max(5, Number(query.get('replay')) || 60) : null,
};
if (config.baseline) config.baseline = asFolder(config.baseline);
let activeData = asFolder(query.get('run') ? `/runs/${query.get('run')}/` : config.data);

// ---------- formatting ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Only http(s) data links are rendered; anything else in the data is shown as plain text. */
const safeUrl = (url) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

function usd(nanos) {
  const value = (nanos ?? 0) / NANOS_PER_USD;
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const count = (n) => (n ?? 0).toLocaleString('en-US');

function minutes(fromIso, toIso) {
  const span = Math.max(0, new Date(toIso) - new Date(fromIso));
  const mins = Math.round(span / 60000);
  if (mins < 1) return `${Math.round(span / 1000)} s`;
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const link = (url, text) => {
  const href = safeUrl(url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : '';
};

const idEvidence = (label, value) =>
  value ? `<span class="evidence-id">${esc(label)} <code tabindex="0" title="Select to copy">${esc(value)}</code></span>` : '';

function aoSessionEvidence(sessionId) {
  if (!sessionId) return '';
  if (!config.aoProject) return idEvidence('AO session', sessionId);
  const href = `ao://sessions/${encodeURIComponent(config.aoProject)}/${encodeURIComponent(sessionId)}`;
  return `<a href="${esc(href)}">AO session</a>`;
}

function traceEvidence(row) {
  return link(row.traceUrl, 'neatlogs trace') || idEvidence('trace', row.traceId);
}

function checkpointEvidence(row) {
  return link(row.checkpointUrl, 'Entire checkpoint') || idEvidence('checkpoint', row.checkpointId);
}

// ---------- reading ----------

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return response.json();
}

async function readRun(folder) {
  const [run, ledger] = await Promise.all([readJson(`${folder}run.json`), readJson(`${folder}ledger.json`)]);
  if (!run || !Array.isArray(run.tasks) || !run.budget) throw new Error('run.json is not a Tally run');
  if (!Array.isArray(ledger)) throw new Error('ledger.json is not a list of attempts');
  return { run, ledger: ledger.filter((row) => row.runId === run.runId || !row.runId) };
}

async function readRunState(folder) {
  const run = await readJson(`${folder}run.json`);
  if (!run || !Array.isArray(run.tasks) || !run.budget) throw new Error('run.json is not a Tally run');
  return run;
}

function runOptionFrom(value) {
  if (typeof value === 'string') return { id: value, path: `/runs/${value}/`, label: value };
  if (!value || typeof value !== 'object') return null;
  const id = value.id ?? value.runId ?? value.name;
  const path = value.path ?? value.url ?? (id ? `/runs/${id}/` : null);
  if (typeof id !== 'string' || typeof path !== 'string') return null;
  return {
    id,
    path: asFolder(path),
    label: typeof value.label === 'string' ? value.label : id,
    status: typeof value.status === 'string' ? value.status : null,
    mode: typeof value.mode === 'string' ? value.mode : null,
    repo: typeof value.repo === 'string' ? value.repo : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

async function readRunsIndex() {
  const index = await readJson(config.runsIndex);
  const rawRuns = Array.isArray(index) ? index : Array.isArray(index?.runs) ? index.runs : [];
  return rawRuns.map(runOptionFrom).filter(Boolean);
}

// ---------- drawing ----------

/** Replaces a section's markup only when it changed, so links and selections survive a poll. */
function draw(id, html) {
  const node = document.getElementById(id);
  if (node.__html === html) return;
  node.__html = html;
  node.innerHTML = html;
}

const passedCount = (run) => run.tasks.filter((task) => task.status === 'passed').length;
const perMergedPr = (run) => (passedCount(run) > 0 ? run.budget.spentNanos / passedCount(run) : null);
const passRate = (run) => (run.tasks.length > 0 ? passedCount(run) / run.tasks.length : 0);

function runSummary(run) {
  return {
    runId: run.runId,
    mode: run.mode,
    passed: passedCount(run),
    total: run.tasks.length,
    passRate: passRate(run),
    totalCost: run.budget.spentNanos,
    perMerged: perMergedPr(run),
  };
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function spread(values, format) {
  const clean = values.filter((value) => value !== null && Number.isFinite(value));
  if (clean.length === 0) return '<span class="blank">none</span>';
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const mid = median(clean);
  return min === max ? format(min) : `${format(min)}-${format(max)} <span class="spread-mid">median ${format(mid)}</span>`;
}

/** Tally marks: groups of four strokes crossed by a fifth. */
function tallyMarks(n) {
  const groups = [];
  for (let left = n; left > 0; left -= 5) {
    const strokes = Math.min(left, 4);
    const crossed = left >= 5;
    const lines = Array.from({ length: strokes }, (_, i) => `<path d="M${5 + i * 7} 3v22"/>`).join('');
    const slash = crossed ? '<path d="M1 22 30 7"/>' : '';
    groups.push(`<svg viewBox="0 0 ${crossed ? 32 : strokes * 7 + 3} 28" aria-hidden="true">${lines}${slash}</svg>`);
  }
  return groups.join('');
}

function drawRun(run) {
  const mode = run.mode === 'baseline' ? 'Baseline: every task on the strongest model' : 'Routed by Tally';
  const state =
    run.status === 'finished'
      ? `Finished in ${minutes(run.startedAt, run.endedAt ?? run.updatedAt)}`
      : run.status === 'interrupted'
        ? `Interrupted after ${minutes(run.startedAt, run.updatedAt)}`
        : `<span class="live"></span>Running, ${minutes(run.startedAt, run.updatedAt)} in`;
  draw(
    'run',
    `<div><dt>Repository</dt><dd>${esc(run.repo)}</dd></div>
     <div><dt>Run</dt><dd>${esc(run.runId)}</dd></div>
     <div><dt>Routing</dt><dd>${mode}</dd></div>
     <div><dt>State</dt><dd>${state}</dd></div>`,
  );
}

function drawNotice(run, source) {
  const lines = [];
  if (source.sample) lines.push(`Sample data: this page is reading the bundled fixture at ${esc(config.sample)}, not a live Tally run.`);
  if (source.replaying) lines.push('Replay of a finished run, speeded up. Nothing is running now.');
  if (run.dryRun) lines.push('Simulated run: the workers are scripted and no money is spent.');
  if (source.stale) lines.push(`Could not read ${esc(activeData)}run.json just now (${esc(source.stale)}). Showing the last figures read.`);
  const node = document.getElementById('notice');
  node.hidden = lines.length === 0;
  draw('notice', lines.join(' '));
}

function sourceLabel(source) {
  if (source.sample && source.replaying) return `Reading bundled sample fixture as a replay from ${config.sample}`;
  if (source.sample) return `Reading bundled sample fixture from ${config.sample}`;
  if (source.replaying) return `Replaying run files from ${activeData}`;
  return activeData.includes('/latest/') || activeData.endsWith('/latest/') ? `Reading latest run files from ${activeData}` : `Reading run files from ${activeData}`;
}

function dataKind(run, source) {
  if (source.sample) return 'sample data';
  if (source.replaying) return 'replay data';
  if (run.dryRun) return 'simulated dry run';
  return 'real run';
}

function drawDataSource(run, source) {
  draw('data-source', `<span class="data-label">${esc(dataKind(run, source))}</span> Data source: <span class="fig">${esc(sourceLabel(source))}</span>`);
}

function drawRunPicker(source) {
  const node = document.getElementById('run-picker');
  node.hidden = false;
  if (source.sample) {
    draw('run-picker', '<p class="picker-note">Run picker is hidden while viewing bundled sample data.</p>');
    return;
  }
  if (source.runsIndexError) {
    draw(
      'run-picker',
      `<p class="picker-note">Run picker unavailable: publish <span class="fig">${esc(config.runsIndex)}</span> with recorded run folders to switch runs here.</p>`,
    );
    return;
  }
  const runs = source.runs ?? [];
  if (runs.length === 0) {
    draw('run-picker', '<p class="picker-note">Run picker found no recorded runs yet.</p>');
    return;
  }
  const options = runs
    .map((run) => {
      const meta = [run.status, run.mode, run.updatedAt ? new Date(run.updatedAt).toLocaleString() : null].filter(Boolean).join(' - ');
      const label = `${run.label}${meta ? ` - ${meta}` : ''}`;
      return `<option value="${esc(run.path)}" ${asFolder(run.path) === activeData ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
  draw(
    'run-picker',
    `<label for="run-select">Recorded run</label>
     <select id="run-select">${options}</select>
     <span class="picker-note">${runs.length} ${runs.length === 1 ? 'run' : 'runs'} indexed from <span class="fig">${esc(config.runsIndex)}</span></span>`,
  );
  const select = document.getElementById('run-select');
  if (select && !select.__tallyBound) {
    select.__tallyBound = true;
    select.addEventListener('change', () => {
      activeData = asFolder(select.value);
      lastGood = null;
      replayStart = null;
      const next = new URL(location.href);
      next.searchParams.set('data', activeData);
      next.searchParams.delete('run');
      history.replaceState(null, '', next);
      tick();
    });
  }
}

function drawHeadline(run, baseline) {
  const passed = passedCount(run);
  const each = perMergedPr(run);
  const done = run.tasks.filter((task) => ['passed', 'failed', 'skipped'].includes(task.status)).length;
  let compare = '';
  if (baseline) {
    const baseEach = perMergedPr(baseline.run);
    if (baseEach === null) {
      compare = `<p class="compare">Baseline run ${esc(baseline.run.runId)} has no passed task to compare with yet.</p>`;
    } else {
      let verdict = '';
      if (each !== null) {
        const change = (each - baseEach) / baseEach;
        const pct = Math.round(Math.abs(change) * 100);
        const sofar = run.status === 'running' ? ' so far' : '';
        verdict =
          change > 0.005
            ? `<span class="over">${pct}% more than baseline${sofar}</span>`
            : change < -0.005
              ? `<span>${pct}% less than baseline${sofar}</span>`
              : `<span>the same as baseline${sofar}</span>`;
      }
      compare = `<p class="compare">
        <span class="base"><b class="fig">${usd(baseEach)}</b> on the baseline, where every task went to the strongest model
        (${passedCount(baseline.run)} of ${baseline.run.tasks.length} passed, ${usd(baseline.run.budget.spentNanos)} spent)</span>
        ${verdict}</p>`;
    }
  }
  draw(
    'headline',
    `<h2>Cost per merged pull request</h2>
     <p class="big fig">${each === null ? '<span class="none">none yet</span>' : usd(each)}</p>
     <p class="marks">${tallyMarks(passed)}<span>${passed} of ${run.tasks.length} tasks passed${done < run.tasks.length ? `, ${run.tasks.length - done} still open` : ''}</span></p>
     ${compare}`,
  );
}

function drawComparison(run, source) {
  const node = document.getElementById('comparison-section');
  const baseline = source.baseline?.run ?? null;
  const repeatRuns = source.comparisonRuns ?? [];
  if (!baseline && repeatRuns.length === 0) {
    node.hidden = true;
    draw('comparison', '');
    return;
  }
  node.hidden = false;
  const rows = [runSummary(run), baseline ? runSummary(baseline) : null].filter(Boolean);
  const repeatGroups = ['tally', 'baseline']
    .map((mode) => {
      const group = repeatRuns.filter((item) => item.mode === mode);
      if (group.length === 0) return '';
      return `<tr>
        <td>${mode === 'baseline' ? 'Baseline repeats' : 'Tally repeats'}<span class="l-note">${group.length} ${group.length === 1 ? 'run' : 'runs'}</span></td>
        <td class="num fig">${spread(group.map((item) => item.perMerged), usd)}</td>
        <td class="num fig">${spread(group.map((item) => item.passRate), pct)}</td>
        <td class="num fig">${spread(group.map((item) => item.totalCost), usd)}</td>
      </tr>`;
    })
    .join('');
  const body = rows
    .map(
      (item) => `<tr>
        <td>${item.mode === 'baseline' ? 'Baseline' : 'Tally'}<span class="l-note">${esc(item.runId)}</span></td>
        <td class="num fig">${item.perMerged === null ? '<span class="blank">none</span>' : usd(item.perMerged)}</td>
        <td class="num fig">${pct(item.passRate)}<span class="l-note">${item.passed}/${item.total} passed</span></td>
        <td class="num fig">${usd(item.totalCost)}</td>
      </tr>`,
    )
    .join('');
  draw(
    'comparison',
    `<div class="scroll"><table class="comparison">
      <thead><tr><th>Run set</th><th class="num">Cost per merged PR</th><th class="num">Pass rate</th><th class="num">Total cost</th></tr></thead>
      <tbody>${body}${repeatGroups}</tbody>
    </table></div>`,
  );
}

function budgetSource(run) {
  if (run.budget.source !== 'cfoai') return 'Source: tally.yaml';
  const detail = run.integrations?.cfoai?.detail;
  const label = 'Source: cfo.ai budget table';
  if (typeof detail === 'string' && /^https?:\/\//.test(detail)) {
    return `Source: <a href="${esc(detail)}" target="_blank" rel="noreferrer">cfo.ai budget table</a>`;
  }
  return label;
}

function drawBudget(run, ledger) {
  const { limitNanos, spentNanos } = run.budget;
  const over = spentNanos > limitNanos;
  const scale = Math.max(limitNanos, spentNanos) || 1;
  const segments = ledger
    .filter((row) => displayedCost(row) > 0)
    .map((row) => {
      const cls = row.result === 'stopped' ? 'seg stop' : isRunning(row) ? 'seg run' : 'seg';
      const live = row.displayIsLiveEstimate ? ' live estimate toward ceiling' : '';
      const label = `${row.taskId} attempt ${row.attempt}, ${row.model}: ${usd(displayedCost(row))}${row.costSource === 'simulated' ? ' simulated' : ''}${live}`;
      return `<span class="${cls}" style="width:${((displayedCost(row) / scale) * 100).toFixed(3)}%" title="${esc(label)}"></span>`;
    })
    .join('');
  const limitAt = ((limitNanos / scale) * 100).toFixed(3);
  const source = budgetSource(run);
  draw(
    'budget',
    `<h2>Budget</h2>
     <p class="budget-figs">
       <span><b class="fig ${over ? 'over' : ''}">${usd(spentNanos)}</b> spent</span>
       <span><b class="fig ${over ? 'over' : ''}">${over ? usd(spentNanos - limitNanos) : usd(limitNanos - spentNanos)}</b> ${over ? 'over budget' : 'remaining'}</span>
     </p>
     <div class="bar ${over ? 'is-over' : ''}" role="img" aria-label="${usd(spentNanos)} spent of ${usd(limitNanos)}">
       ${segments}<i class="limit" style="left:${limitAt}%"></i>
     </div>
     <p class="bar-scale"><span>$0</span><span>${usd(limitNanos)} limit</span></p>
     <p class="budget-source">${source}</p>
     <p class="bar-key">One block per attempt, in the order they ran.
       ${ledger.some((row) => row.displayIsLiveEstimate) ? '<span>Grey blocks are live estimates for attempts still running.</span>' : ''}
       ${ledger.some((row) => row.result === 'stopped') ? '<span class="key-stop">Red is money spent before a worker was stopped at its ceiling.</span>' : ''}</p>`,
  );
}

const INTEGRATIONS = [
  ['neatlogs', 'neatlogs', 'traces'],
  ['entire', 'Entire', 'checkpoints and handoff'],
  ['cfoai', 'cfo.ai', 'live budget'],
  ['github', 'GitHub', 'issues and pull requests'],
  ['slack', 'Slack', 'alerts'],
];
const INTEGRATION_WORD = { ok: 'on', off: 'off', missing: 'not connected', error: 'broken' };
const INTEGRATION_OFF_NOTE = {
  neatlogs: 'Off for this run; traces were not sent.',
  entire: 'Off for this run; checkpoints and handoff use local fallback.',
  cfoai: 'Off for this run; budget comes from tally.yaml.',
  github: 'Off for this run; backlog came from a file.',
  slack: 'Off for this run; alerts were not sent.',
};

function drawIntegrations(run) {
  const items = INTEGRATIONS.filter(([key]) => run.integrations?.[key] && (key !== 'slack' || run.integrations[key].status !== 'off')).map(
    ([key, name, job]) => {
      const { status, detail } = run.integrations[key];
      const note = detail ?? (status === 'off' ? INTEGRATION_OFF_NOTE[key] : job);
      const linkedNote =
        key === 'cfoai' && status !== 'off' && typeof note === 'string' && /^https?:\/\//.test(note)
          ? `<a href="${esc(note)}" target="_blank" rel="noreferrer">Open budget table</a>`
          : esc(note);
      return `<div class="int int-${esc(status)}">
        <span class="box" aria-hidden="true"></span>
        <p><b>${name}</b> <span class="state">${INTEGRATION_WORD[status] ?? esc(status)}</span>
        <span class="detail">${linkedNote}</span></p></div>`;
    },
  );
  draw('integrations', items.join(''));
}

const RESULT_WORD = { passed: 'Passed', failed: 'Failed', stopped: 'Stopped at ceiling', error: 'Errored', running: 'Running' };
const STATUS_WORD = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', skipped: 'Skipped' };

function statusMark(kind, text) {
  const live = kind === 'running' ? '<span class="live"></span>' : '';
  return `<span class="status status-${esc(kind)}">${live}${esc(text)}</span>`;
}

/** Cost against a ceiling: the track is the ceiling, and anything past it runs over in red. */
function costCell(costNanos, ceilingNanos, stopped, costSource, liveEstimate = false) {
  const source = [
    liveEstimate ? '<span class="l-note">live estimate until the attempt writes final usage</span>' : '',
    costSource === 'simulated' ? '<span class="l-note">simulated</span>' : costSource === 'ao-estimate' ? '<span class="l-note">orchestrator estimate</span>' : '',
  ].join('');
  if (!ceilingNanos) return `<p class="fig cost">${usd(costNanos)}</p>${source}`;
  const share = costNanos / ceilingNanos;
  const over = share > 1;
  const fill = Math.min(share, 1) * 100;
  const spill = over ? Math.min((share - 1) * 100, 14) + 3 : 0;
  return `<p class="fig cost ${over || stopped ? 'over' : ''}">${usd(costNanos)} <span class="of">of ${usd(ceilingNanos)}</span></p>
    <div class="meter" role="img" aria-label="${Math.round(share * 100)}% of ceiling">
      <span class="fill" style="width:${fill.toFixed(2)}%"></span>${over ? `<span class="spill" style="width:${spill.toFixed(2)}%"></span>` : ''}
    </div>${source}`;
}

function tierCell(tier, model) {
  return tier ? `<b>${esc(tier)}</b><span class="model">${esc(model ?? '')}</span>` : '<span class="blank">not routed yet</span>';
}

function attemptCountCell(task, attempts, awaiting) {
  const countText = attempts.length === 1 ? '1 attempt' : `${attempts.length} attempts`;
  const ids = attempts.map((row) => `${row.taskId}/${row.attempt}`).join(', ');
  const extra = awaiting ? `${ids ? `${ids}, ` : ''}${task.taskId}/${attempts.length + 1} pending` : ids;
  return `<span class="attempt-count">${esc(countText)}</span>${extra ? `<span class="attempt-list">Ledger rows: ${esc(extra)}</span>` : ''}`;
}

const IMPACT_LABELS = {
  expectedCostNanos: 'expected cost',
  topCostNanos: 'top-tier cost',
  savingsNanos: 'saved',
  avoidedCostNanos: 'avoided',
  costDeltaNanos: 'cost delta',
  passRateDelta: 'pass-rate delta',
  confidenceDelta: 'confidence delta',
};

function impactValue(key, value) {
  if (!Number.isFinite(value)) return null;
  if (key.endsWith('Nanos')) return usd(value);
  if (key.endsWith('Rate') || key.endsWith('Delta') || Math.abs(value) <= 1) return `${Math.round(value * 100)}%`;
  return count(value);
}

function taskImpact(task, attempts) {
  const sources = [task.impact, task.impactNumbers, task.routingImpact, task.routing?.impact].filter(Boolean);
  const flat = {
    expectedCostNanos: task.expectedCostNanos,
    topCostNanos: task.topCostNanos,
    savingsNanos: task.savingsNanos,
    avoidedCostNanos: task.avoidedCostNanos,
    costDeltaNanos: task.costDeltaNanos,
    passRateDelta: task.passRateDelta,
    confidenceDelta: task.confidenceDelta,
  };
  sources.push(flat);
  const items = [];
  for (const source of sources) {
    for (const [key, raw] of Object.entries(source)) {
      if (!Object.hasOwn(IMPACT_LABELS, key)) continue;
      const value = impactValue(key, Number(raw));
      if (!value) continue;
      items.push(`<span><b>${esc(IMPACT_LABELS[key])}</b> ${esc(value)}</span>`);
    }
  }
  const changed =
    task.historyChangedDecision === true ||
    task.historyChanged === true ||
    task.routing?.historyChangedDecision === true ||
    task.routing?.historyChanged === true ||
    attempts.some((row) => row.historyChangedDecision === true || row.historyChanged === true || row.routing?.historyChangedDecision === true);
  return `${changed ? '<span class="history-mark">history changed route</span>' : ''}${items.length ? `<span class="impact">${items.join('')}</span>` : ''}`;
}

function finalRouteCell(task, attempts, awaiting) {
  const stopped = attempts.find((row) => row.result === 'stopped');
  const last = attempts[attempts.length - 1];
  if (attempts.length === 0) return tierCell(task.tier, task.model);
  const note =
    stopped && last && last.attempt > stopped.attempt
      ? `<span class="model">stopped on ${esc(stopped.tier)}, continued on ${esc(last.tier)}</span>`
      : awaiting
        ? '<span class="model">waiting for the next model up</span>'
        : `<span class="model">${esc(last?.result ?? task.status)}</span>`;
  return `${tierCell(task.tier ?? last?.tier, task.model ?? last?.model)}${note}`;
}

function taskDecision(attempts) {
  if (attempts.length === 0) return '<span class="blank">No model has been paid to try yet.</span>';
  const first = attempts[0];
  const last = attempts[attempts.length - 1];
  const carry = attempts.length > 1 && last?.escalatedFrom ? `<p class="carried">Latest attempt continues the previous work.</p>` : '';
  return `${carry}<p>${esc(first.decision)}</p>${last?.attempt !== first.attempt ? `<p class="reason">Final decision: ${esc(last.decision)}</p>` : ''}${last?.resultReason ? `<p class="reason ${last.result === 'stopped' ? 'over' : ''}">${esc(last.resultReason)}</p>` : ''}`;
}

function drawTasks(run, ledger) {
  const body = run.tasks
    .map((task, index) => {
      const attempts = ledger.filter((row) => row.taskId === task.taskId).sort((a, b) => a.attempt - b.attempt);
      const last = attempts[attempts.length - 1];
      // A stopped or failed attempt with the task still open means the next model has not started yet.
      const awaiting = last && !isRunning(last) && last.result !== 'passed' && ['running', 'pending'].includes(task.status);
      const issue = link(task.issueUrl, `#${task.issueNumber}`);
      const pr = link(task.prUrl, 'pull request');
      const classes = [`t-${esc(task.status)}`, attempts.some((row) => row.result === 'stopped') ? 'has-stop' : ''].join(' ');
      return `<tr class="${classes}">
        <td class="no fig">${index + 1}</td>
        <td class="task">
          <p class="title">${esc(task.title)}</p>
          <p class="refs">${[esc(task.taskId), issue, pr].filter(Boolean).join('<span class="gap"></span>')}</p>
          ${taskImpact(task, attempts)}
          ${task.statusReason ? `<p class="why-status">${esc(task.statusReason)}</p>` : ''}
        </td>
        <td class="size">${task.size ? esc(task.size) : '<span class="blank">unsized</span>'}</td>
        <td class="tier">${finalRouteCell(task, attempts, awaiting)}</td>
        <td class="attempts">${attemptCountCell(task, attempts, awaiting)}</td>
        <td class="why">${taskDecision(attempts)}</td>
        <td class="money">${costCell(task.spentNanos ?? 0, null, attempts.some((row) => row.result === 'stopped'), attempts.length > 0 && attempts.every((row) => row.costSource === 'simulated') ? 'simulated' : attempts[0]?.costSource, attempts.some((row) => row.displayIsLiveEstimate))}</td>
        <td class="state">${attempts.some((row) => row.result === 'stopped') ? '<span class="stamp">Stopped and escalated</span>' : statusMark(task.status, STATUS_WORD[task.status] ?? task.status)}</td>
      </tr>`;
    })
    .join('');

  draw(
    'tasks',
    `<thead><tr>
       <th class="no">No.</th><th>Task</th><th>Size</th><th>Ended up on</th><th>Attempts</th><th>Why</th>
       <th class="money">Total cost</th><th>Status</th></tr></thead>
     <tbody>${body}</tbody>`,
  );
}

function isSuspectPass(row, run) {
  if (row.result !== 'passed') return false;
  const hasTokens = (row.tokens?.total ?? 0) > 0;
  const zeroCostWithTokens = hasTokens && displayedCost(row) === 0;
  const missingWorkEvidence = !run.dryRun && row.costSource !== 'simulated' && !row.prUrl && !row.branch;
  return zeroCostWithTokens || missingWorkEvidence;
}

function drawLedger(run, ledger) {
  const seenTasks = new Set();
  const rows = ledger
    .map((row) => {
      const running = isRunning(row);
      const kind = running ? 'running' : row.result;
      const suspect = isSuspectPass(row, run);
      const groupStart = !seenTasks.has(row.taskId);
      seenTasks.add(row.taskId);
      const links = [link(row.prUrl, 'PR'), aoSessionEvidence(row.sessionId), checkpointEvidence(row), traceEvidence(row)].filter(Boolean);
      const tokenSplit = `${count(row.tokens.uncachedInput)} in, ${count(row.tokens.cachedInput)} cached, ${count(row.tokens.output)} out`;
      return `<tr class="a-${esc(kind)} ${suspect ? 'a-suspect' : ''} ${groupStart ? 'group-start' : ''}">
        <td class="fig">${esc(row.taskId)}/${row.attempt}</td>
        <td class="l-task"><span class="l-task-id">${esc(row.taskId)}</span>${esc(row.taskTitle)}${row.escalatedFrom ? '<span class="l-note">continues the attempt above it</span>' : ''}</td>
        <td><span class="fig">${esc(row.model)}</span><span class="l-note">${esc(row.tier)} tier, ${esc(row.harness)}</span></td>
        <td class="num"><span class="fig">${count(row.tokens.total)}</span><span class="l-note">${tokenSplit}</span></td>
        <td class="num fig ${row.result === 'stopped' ? 'over' : ''}">${usd(displayedCost(row))}${
          row.displayIsLiveEstimate ? '<span class="l-note">live estimate</span>' : row.costSource === 'simulated' ? '<span class="l-note">simulated</span>' : row.costSource === 'ao-estimate' ? '<span class="l-note">orchestrator estimate</span>' : ''
        }</td>
        <td class="num fig">${usd(row.ceilingNanos)}</td>
        <td class="num fig">${running ? `since ${clock(row.startedAt)}` : minutes(row.startedAt, row.endedAt ?? row.startedAt)}</td>
        <td class="l-result">${row.result === 'stopped' ? '<b class="over">Stopped at ceiling</b>' : statusMark(kind, RESULT_WORD[kind] ?? kind)}${suspect ? '<span class="suspect">suspect pass</span>' : ''}${row.resultReason && row.result !== 'stopped' ? `<span class="l-note">${esc(row.resultReason)}</span>` : ''}</td>
        <td class="l-links">${links.length ? links.join(' ') : '<span class="blank">none yet</span>'}${suspect ? '<span class="l-note over">Missing PR/branch evidence or has zero cost with non-zero tokens.</span>' : ''}</td></tr>`;
    })
    .join('');
  const tokens = ledger.reduce((sum, row) => sum + row.tokens.total, 0);
  const cost = ledger.reduce((sum, row) => sum + displayedCost(row), 0);
  const empty = `<tr><td colspan="9" class="empty">No attempt has been entered yet. Rows appear here as workers start.</td></tr>`;
  draw(
    'ledger',
    `<thead><tr><th>Attempt</th><th>Task</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost</th>
       <th class="num">Ceiling</th><th class="num">Time</th><th>Result</th><th>Evidence</th></tr></thead>
     <tbody>${rows || empty}</tbody>
     <tfoot><tr><td colspan="3">Total, ${ledger.length} ${ledger.length === 1 ? 'attempt' : 'attempts'}</td>
       <td class="num fig">${count(tokens)}</td><td class="num fig total">${usd(cost)}</td><td colspan="4">${
         ledger.some((row) => row.displayIsLiveEstimate)
           ? 'includes live estimates for running attempts'
           : Math.abs(cost - run.budget.spentNanos) > 1
             ? `<span class="over">does not match the ${usd(run.budget.spentNanos)} the run reports as spent</span>`
             : 'agrees with the budget spent'
       }</td></tr></tfoot>`,
  );
}

function drawFoot(source) {
  const from = sourceLabel(source);
  draw(
    'foot',
    `<p>Read-only. <span class="fig">${esc(from)}</span>; polls run.json and ledger.json every ${(config.intervalMs / 1000).toLocaleString()} s.
     Last read at ${new Date().toLocaleTimeString()}.</p>
     <p>Cost is tokens used multiplied by the list price in tally.yaml, whether a worker ran on an API key or a subscription.</p>`,
  );
}

function drawAll(state, source) {
  state = withLiveCosts(state, { liveCeilingSec: config.liveCeilingSec });
  drawRun(state.run);
  drawNotice(state.run, source);
  drawDataSource(state.run, source);
  drawRunPicker(source);
  drawHeadline(state.run, source.baseline);
  drawBudget(state.run, state.ledger);
  drawComparison(state.run, source);
  drawIntegrations(state.run);
  drawTasks(state.run, state.ledger);
  drawLedger(state.run, state.ledger);
  drawFoot(source);
  document.title = `Tally: ${usd(state.run.budget.spentNanos)} of ${usd(state.run.budget.limitNanos)}`;
}

function drawUnreadable(error) {
  document.body.classList.add('unread');
  const node = document.getElementById('notice');
  node.hidden = false;
  draw(
    'notice',
    `Nothing to show yet: ${esc(activeData)}run.json could not be read (${esc(error.message)}).
     Start a run with <span class="fig">tally run</span> or <span class="fig">tally demo</span>, or point this page at a run folder by adding
     <span class="fig">?data=path/to/run/</span> to the address. The page must be opened over http, not as a file.`,
  );
}

// ---------- the loop ----------

let lastGood = null;
let usingSample = config.useSample;
let baseline = null;
let replayStart = null;
let runs = [];
let runsIndexError = null;
let runsIndexReadAt = 0;
let comparisonRuns = [];
let comparisonReadAt = 0;

async function tick() {
  let stale = null;
  try {
    lastGood = await readRun(usingSample ? config.sample : activeData);
  } catch (error) {
    if (!lastGood) return drawUnreadable(error);
    if (!usingSample) stale = error.message;
  }
  if (!usingSample && performance.now() - runsIndexReadAt > 5000) {
    runsIndexReadAt = performance.now();
    try {
      runs = await readRunsIndex();
      runsIndexError = null;
    } catch (error) {
      runsIndexError = error.message;
    }
  }
  if (!usingSample && runs.length > 0 && performance.now() - comparisonReadAt > 15000) {
    comparisonReadAt = performance.now();
    const read = await Promise.allSettled(runs.map((run) => readRunState(run.path)));
    comparisonRuns = read
      .filter((result) => result.status === 'fulfilled')
      .map((result) => runSummary(result.value))
      .filter((item) => item.mode === 'tally' || item.mode === 'baseline');
  }
  if (config.baseline) {
    try {
      baseline = await readRun(config.baseline);
    } catch {
      /* keep the last baseline read, if any */
    }
  }
  document.body.classList.remove('unread');

  let state = lastGood;
  let replaying = false;
  if (config.replaySec) {
    replayStart ??= performance.now();
    const fraction = (performance.now() - replayStart) / (config.replaySec * 1000);
    replaying = fraction < 1;
    state = frameAt(lastGood.run, lastGood.ledger, fraction);
  }
  drawAll(state, { sample: usingSample, stale, baseline, replaying, runs, runsIndexError, comparisonRuns });
}

async function loop() {
  await tick();
  setTimeout(loop, config.replaySec ? Math.min(config.intervalMs, 1000) : config.intervalMs);
}

loop();
