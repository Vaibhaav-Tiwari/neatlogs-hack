// Tally dashboard. Reads run.json and ledger.json on a timer and redraws.
// It never writes anything.

import { frameAt } from './replay-core.js';

const NANOS_PER_USD = 1_000_000_000;

const query = new URLSearchParams(location.search);
const defaults = window.TALLY_DASHBOARD ?? {};
const asFolder = (path) => (path.endsWith('/') ? path : `${path}/`);
const hasExplicitData = query.has('data');
const wantsDemo = query.has('demo');
const wantsReplay = query.has('replay');
const config = {
  data: asFolder(query.get('data') ?? defaults.data ?? './'),
  baseline: query.get('baseline') ?? defaults.baseline ?? null,
  intervalMs: Math.max(250, Number(query.get('interval') ?? defaults.intervalMs ?? 2000) || 2000),
  sample: defaults.sample ?? null,
  // ?demo shows the checked-in sample. ?replay=60 plays the chosen run over that many seconds.
  useSample: wantsDemo || (wantsReplay && !hasExplicitData),
  replaySec: wantsReplay ? Math.max(5, Number(query.get('replay')) || 60) : null,
};
if (config.baseline) config.baseline = asFolder(config.baseline);

// ---------- formatting ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Only http(s) links are rendered; anything else in the data is shown as plain text. */
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

const isRunning = (row) => row.result === 'running' || (!row.endedAt && !['passed', 'failed', 'stopped', 'error'].includes(row.result));

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
  if (source.stale) lines.push(`Could not read ${esc(config.data)}run.json just now (${esc(source.stale)}). Showing the last figures read.`);
  const node = document.getElementById('notice');
  node.hidden = lines.length === 0;
  draw('notice', lines.join(' '));
}

function sourceLabel(source) {
  if (source.sample && source.replaying) return `Reading bundled sample fixture as a replay from ${config.sample}`;
  if (source.sample) return `Reading bundled sample fixture from ${config.sample}`;
  if (source.replaying) return `Replaying run files from ${config.data}`;
  return config.data.includes('/latest/') || config.data.endsWith('/latest/') ? `Reading latest run files from ${config.data}` : `Reading run files from ${config.data}`;
}

function drawDataSource(source) {
  draw('data-source', `Data source: <span class="fig">${esc(sourceLabel(source))}</span>`);
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

function drawBudget(run, ledger) {
  const { limitNanos, spentNanos } = run.budget;
  const over = spentNanos > limitNanos;
  const scale = Math.max(limitNanos, spentNanos) || 1;
  const segments = ledger
    .filter((row) => row.estimatedCostNanos > 0)
    .map((row) => {
      const cls = row.result === 'stopped' ? 'seg stop' : isRunning(row) ? 'seg run' : 'seg';
      const label = `${row.taskId} attempt ${row.attempt}, ${row.model}: ${usd(row.estimatedCostNanos)}${row.costSource === 'simulated' ? ' simulated' : ''}`;
      return `<span class="${cls}" style="width:${((row.estimatedCostNanos / scale) * 100).toFixed(3)}%" title="${esc(label)}"></span>`;
    })
    .join('');
  const limitAt = ((limitNanos / scale) * 100).toFixed(3);
  const source = run.budget.source === 'cfoai' ? 'budget read from cfo.ai' : 'budget set in tally.yaml';
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
     <p class="bar-scale"><span>$0</span><span>${usd(limitNanos)}, ${source}</span></p>
     <p class="bar-key">One block per attempt, in the order they ran.
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
      return `<div class="int int-${esc(status)}">
        <span class="box" aria-hidden="true"></span>
        <p><b>${name}</b> <span class="state">${INTEGRATION_WORD[status] ?? esc(status)}</span>
        <span class="detail">${esc(note)}</span></p></div>`;
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
function costCell(costNanos, ceilingNanos, stopped, costSource) {
  const source = costSource === 'simulated' ? '<span class="l-note">simulated</span>' : costSource === 'ao-estimate' ? '<span class="l-note">orchestrator estimate</span>' : '';
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
          ${task.statusReason ? `<p class="why-status">${esc(task.statusReason)}</p>` : ''}
        </td>
        <td class="size">${task.size ? esc(task.size) : '<span class="blank">unsized</span>'}</td>
        <td class="tier">${finalRouteCell(task, attempts, awaiting)}</td>
        <td class="attempts">${attemptCountCell(task, attempts, awaiting)}</td>
        <td class="why">${taskDecision(attempts)}</td>
        <td class="money">${costCell(task.spentNanos ?? 0, null, attempts.some((row) => row.result === 'stopped'), attempts.length > 0 && attempts.every((row) => row.costSource === 'simulated') ? 'simulated' : attempts[0]?.costSource)}</td>
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

function drawLedger(run, ledger) {
  const seenTasks = new Set();
  const rows = ledger
    .map((row) => {
      const running = isRunning(row);
      const kind = running ? 'running' : row.result;
      const groupStart = !seenTasks.has(row.taskId);
      seenTasks.add(row.taskId);
      const links = [link(row.prUrl, 'PR'), link(row.traceUrl, 'trace'), link(row.checkpointUrl, 'checkpoint')].filter(Boolean);
      const tokenSplit = `${count(row.tokens.uncachedInput)} in, ${count(row.tokens.cachedInput)} cached, ${count(row.tokens.output)} out`;
      return `<tr class="a-${esc(kind)} ${groupStart ? 'group-start' : ''}">
        <td class="fig">${esc(row.taskId)}/${row.attempt}</td>
        <td class="l-task"><span class="l-task-id">${esc(row.taskId)}</span>${esc(row.taskTitle)}${row.escalatedFrom ? '<span class="l-note">continues the attempt above it</span>' : ''}</td>
        <td><span class="fig">${esc(row.model)}</span><span class="l-note">${esc(row.tier)} tier, ${esc(row.harness)}</span></td>
        <td class="num"><span class="fig">${count(row.tokens.total)}</span><span class="l-note">${tokenSplit}</span></td>
        <td class="num fig ${row.result === 'stopped' ? 'over' : ''}">${usd(row.estimatedCostNanos)}${row.costSource === 'simulated' ? '<span class="l-note">simulated</span>' : row.costSource === 'ao-estimate' ? '<span class="l-note">orchestrator estimate</span>' : ''}</td>
        <td class="num fig">${usd(row.ceilingNanos)}</td>
        <td class="num fig">${running ? `since ${clock(row.startedAt)}` : minutes(row.startedAt, row.endedAt ?? row.startedAt)}</td>
        <td class="l-result">${row.result === 'stopped' ? '<b class="over">Stopped at ceiling</b>' : statusMark(kind, RESULT_WORD[kind] ?? kind)}${row.resultReason && row.result !== 'stopped' ? `<span class="l-note">${esc(row.resultReason)}</span>` : ''}</td>
        <td class="l-links">${links.length ? links.join(' ') : '<span class="blank">none yet</span>'}</td></tr>`;
    })
    .join('');
  const tokens = ledger.reduce((sum, row) => sum + row.tokens.total, 0);
  const cost = ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0);
  const empty = `<tr><td colspan="9" class="empty">No attempt has been entered yet. Rows appear here as workers start.</td></tr>`;
  draw(
    'ledger',
    `<thead><tr><th>Attempt</th><th>Task</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost</th>
       <th class="num">Ceiling</th><th class="num">Time</th><th>Result</th><th>Evidence</th></tr></thead>
     <tbody>${rows || empty}</tbody>
     <tfoot><tr><td colspan="3">Total, ${ledger.length} ${ledger.length === 1 ? 'attempt' : 'attempts'}</td>
       <td class="num fig">${count(tokens)}</td><td class="num fig total">${usd(cost)}</td><td colspan="4">${
         Math.abs(cost - run.budget.spentNanos) > 1 ? `<span class="over">does not match the ${usd(run.budget.spentNanos)} the run reports as spent</span>` : 'agrees with the budget spent'
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
  drawRun(state.run);
  drawNotice(state.run, source);
  drawDataSource(source);
  drawHeadline(state.run, source.baseline);
  drawBudget(state.run, state.ledger);
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
    `Nothing to show yet: ${esc(config.data)}run.json could not be read (${esc(error.message)}).
     Start a run with <span class="fig">tally run</span> or <span class="fig">tally demo</span>, or point this page at a run folder by adding
     <span class="fig">?data=path/to/run/</span> to the address. The page must be opened over http, not as a file.`,
  );
}

// ---------- the loop ----------

let lastGood = null;
let usingSample = config.useSample;
let baseline = null;
let replayStart = null;

async function tick() {
  let stale = null;
  try {
    lastGood = await readRun(usingSample ? config.sample : config.data);
  } catch (error) {
    if (!lastGood) return drawUnreadable(error);
    if (!usingSample) stale = error.message;
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
  drawAll(state, { sample: usingSample, stale, baseline, replaying });
}

async function loop() {
  await tick();
  setTimeout(loop, config.replaySec ? Math.min(config.intervalMs, 1000) : config.intervalMs);
}

loop();
