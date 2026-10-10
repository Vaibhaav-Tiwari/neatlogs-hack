import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { routeBaseline } from '../agent/baseline.js';
import { decideEscalation } from '../agent/escalation.js';
import type {
  BudgetPort,
  HandoffPort,
  LiveUsagePort,
  PriceHistoryPort,
  PriceHistoryWriterPort,
  SessionControlPort,
  SizingSignalsPort,
  TracePort,
} from '../agent/ports.js';
import { routeTask } from '../agent/router.js';
import { sizeTask } from '../agent/sizer.js';
import { checkCeiling, CeilingWatcher } from '../agent/watcher.js';
import { AoCliAdapter } from '../adapters/ao.js';
import { CfoaiBudgetAdapter, CFOAI_FIX_COMMAND } from '../adapters/cfoai.js';
import { EntireSizingAdapter } from '../adapters/entire.js';
import { type BacklogIntakePort, ConfigBacklogIntake } from '../adapters/github.js';
import { FilePriceHistory } from '../adapters/history-file.js';
import { NeatlogsTraceAdapter } from '../adapters/neatlogs.js';
import { CommandVerifier, type VerifierPort } from '../adapters/verifier.js';
import { attemptId, SCHEMA_VERSION, usdToNanos, validateLedger, validateRunState } from '../schema/index.js';
import type { AttemptResult, BudgetSource, IntegrationState, Ledger, LedgerRow, RunMode, RunState, TaskState, TallyConfig, Tier, TokenUsage } from '../schema/index.js';
import { type BacklogTask } from './backlog.js';
import { loadConfig } from './config.js';
import { writeRunFiles } from './output.js';
import type { RunOptions, RunResult } from './run.js';

export interface WorkerStartInput {
  task: BacklogTask;
  attempt: number;
  tier: Tier;
  ceilingNanos: number | null;
  harness: string;
  model: string;
  name: string;
  prompt: string;
  aoProject?: string;
}

export interface WorkerResult {
  status: 'idle' | 'terminated';
  branch: string | null;
  checkoutPath: string | null;
  prUrl: string | null;
}

export interface WorkerPort {
  start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string | null; checkoutPath: string | null }>;
  wait(sessionId: string): Promise<WorkerResult>;
}

export interface CfoaiBudgetPort extends BudgetPort {
  budgetLimitNanos(): Promise<number>;
  writeCumulativeActualSpend(runSpendNanos: number): Promise<void>;
  status(): IntegrationState;
  tableUrl?(): string | undefined;
}

export interface RealRunPorts {
  intake: BacklogIntakePort;
  signals: SizingSignalsPort;
  worker: WorkerPort;
  verifier: VerifierPort;
  usage: LiveUsagePort;
  sessions: SessionControlPort;
  history: PriceHistoryPort & PriceHistoryWriterPort;
  handoff?: HandoffPort;
  trace?: TracePort;
  cfoai?: CfoaiBudgetPort;
}

export interface RealRunOptions extends RunOptions {
  ports?: Partial<RealRunPorts>;
}

class LedgerBudget implements BudgetPort {
  reservedNanos = 0;

  constructor(
    private readonly limitNanos: number,
    private readonly ledger: Ledger,
  ) {}

  async remainingNanos(): Promise<number> {
    const spent = this.ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0);
    return this.limitNanos - spent - this.reservedNanos;
  }
}

const nullSignals: SizingSignalsPort = {
  async signalsFor() {
    return null;
  },
};

function defaultPorts(config: TallyConfig, configPath: string): RealRunPorts {
  const ao = new AoCliAdapter();
  const configDir = dirname(configPath);
  const repoPath = resolve(configDir, config.repo.path);
  const trace = config.integrations.neatlogs ? new NeatlogsTraceAdapter() : undefined;
  const cfoai = config.integrations.cfoai || config.budget.source === 'cfoai' ? new CfoaiBudgetAdapter({ config: config.budget.cfoai }) : undefined;
  return {
    intake: new ConfigBacklogIntake(),
    signals: config.integrations.entire ? new EntireSizingAdapter({ repoPath }) : nullSignals,
    worker: ao,
    verifier: new CommandVerifier(),
    usage: ao,
    sessions: ao,
    history: new FilePriceHistory({ path: resolve(configDir, '.tally', 'history.json') }),
    ...(trace ? { trace } : {}),
    ...(cfoai ? { cfoai } : {}),
  };
}

function runIdFrom(date: Date): string {
  return `run-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')}`;
}

function repoName(config: TallyConfig): string {
  return config.repo.slug ?? config.repo.path;
}

function defaultOutputDir(runId: string): string {
  const base = resolve(`.tally/runs/${runId}`);
  if (!existsSync(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = resolve(`.tally/runs/${runId}-${i}`);
    if (!existsSync(candidate)) return candidate;
  }
}

function traceStatus(trace: TracePort | undefined): RunState['integrations']['neatlogs'] {
  const withStatus = trace as (TracePort & { status?: () => RunState['integrations']['neatlogs'] }) | undefined;
  return withStatus?.status?.() ?? { status: 'missing', detail: 'Trace adapter is not configured.' };
}

function portStatus(port: unknown, fallback: RunState['integrations']['entire']): RunState['integrations']['entire'] {
  const withStatus = port as { status?: () => RunState['integrations']['entire'] };
  return withStatus.status?.() ?? fallback;
}

function integrationStates(config: TallyConfig, ports: RealRunPorts, options: { dryRun: boolean; budgetSource: BudgetSource }): RunState['integrations'] {
  const cfoaiStatus = ports.cfoai?.status() ?? { status: 'missing' as const, detail: CFOAI_FIX_COMMAND };
  return {
    neatlogs: config.integrations.neatlogs ? traceStatus(ports.trace) : { status: 'off', detail: null },
    entire: config.integrations.entire
      ? portStatus(ports.signals, {
          status: 'missing',
          detail: 'Entire sizing adapter is not configured. Falling back to code search. Fix: run `entire enable` in this repository.',
        })
      : { status: 'off', detail: null },
    cfoai: config.integrations.cfoai
      ? options.dryRun && options.budgetSource === 'cfoai' && cfoaiStatus.status === 'ok'
        ? { status: 'ok', detail: 'budget read; spend not written in a dry run' }
        : cfoaiStatus
      : { status: 'off', detail: null },
    github:
      config.backlog.source === 'github-issues'
        ? { status: 'ok', detail: null }
        : { status: 'off', detail: 'Backlog loaded from file.' },
    slack: config.integrations.slack ? { status: 'missing', detail: 'Adapter not implemented yet.' } : { status: 'off', detail: null },
  };
}

function initialTaskState(task: BacklogTask): TaskState {
  return {
    taskId: task.taskId,
    title: task.title,
    issueNumber: task.issueNumber,
    issueUrl: task.issueUrl,
    size: null,
    status: 'pending',
    statusReason: null,
    attempts: 0,
    tier: null,
    model: null,
    spentNanos: 0,
    escalated: false,
    prUrl: null,
  };
}

function promptFor(task: BacklogTask, config: TallyConfig, tier: Tier, handoffSummary: string | null): string {
  return [
    `You are implementing Tally task ${task.taskId}: ${task.title}`,
    '',
    task.body || '(No issue body was provided.)',
    '',
    `Target repo: ${repoName(config)}`,
    `Run this verification command before claiming success: ${config.test.command}`,
    `You are running on tier ${tier.name} (${tier.harness}/${tier.model}).`,
    handoffSummary ? `\nHandoff from the previous attempt:\n${handoffSummary}` : '',
  ].join('\n');
}

function zeroTokens(): TokenUsage {
  return { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
}

function statusFrom(result: AttemptResult): TaskState['status'] {
  return result === 'passed' ? 'passed' : 'failed';
}

function assertValid(runState: RunState, ledger: Ledger): void {
  const errors = [...validateRunState(runState).errors, ...validateLedger(ledger).errors];
  if (errors.length > 0) throw new Error(errors.join('; '));
}

function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as Ledger;
}

function ledgerSpend(ledger: Ledger): number {
  return ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0);
}

function csv(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function appendCfoaiFallback(outputDir: string, row: LedgerRow, cumulativeRunSpendNanos: number): void {
  mkdirSync(outputDir, { recursive: true });
  const path = resolve(outputDir, 'cfoai-spend-fallback.csv');
  if (!existsSync(path)) {
    appendFileSync(path, 'run_id,attempt_id,task_id,attempt,tier,model,cost_usd,cumulative_run_spend_usd,cost_source,ended_at\n');
  }
  appendFileSync(
    path,
    [
      row.runId,
      row.attemptId,
      row.taskId,
      row.attempt,
      row.tier,
      row.model,
      row.estimatedCostNanos / 1_000_000_000,
      cumulativeRunSpendNanos / 1_000_000_000,
      row.costSource,
      row.endedAt,
    ]
      .map(csv)
      .join(',') + '\n',
  );
}

function isTaskDone(rows: LedgerRow[]): boolean {
  const latest = rows[rows.length - 1];
  return latest?.result === 'passed' || (latest !== undefined && latest.attempt >= 2);
}

function stateFromRows(taskState: TaskState, rows: LedgerRow[]): TaskState {
  const latest = rows[rows.length - 1]!;
  return {
    ...taskState,
    size: latest.size,
    status: statusFrom(latest.result),
    statusReason: latest.resultReason,
    attempts: latest.attempt,
    tier: latest.tier,
    model: latest.model,
    spentNanos: rows.reduce((sum, row) => sum + row.estimatedCostNanos, 0),
    escalated: latest.escalatedFrom !== null,
    prUrl: latest.prUrl,
  };
}

async function runAttempt(input: {
  runId: string;
  task: BacklogTask;
  attempt: number;
  tier: Tier;
  ceilingNanos: number | null;
  decision: string;
  escalatedFrom: string | null;
  handoff: LedgerRow['handoff'];
  handoffSummary: string | null;
  config: TallyConfig;
  configPath: string;
  ports: RealRunPorts;
  now: () => Date;
  dryRun: boolean;
}): Promise<LedgerRow> {
  const startedAt = input.now().toISOString();
  const started = await input.ports.worker.start({
    task: input.task,
    attempt: input.attempt,
    tier: input.tier,
    ceilingNanos: input.ceilingNanos,
    harness: input.tier.harness,
    model: input.tier.model,
    name: `tally-${input.runId}-${input.task.taskId}-${input.attempt}`,
    prompt: promptFor(input.task, input.config, input.tier, input.handoffSummary),
    aoProject: input.config.repo.aoProject,
  });
  const watcher = new CeilingWatcher({ usage: input.ports.usage, sessions: input.ports.sessions, trace: input.ports.trace });
  const abort = new AbortController();
  const watched = watcher.watch(
    { sessionId: started.sessionId, tier: input.tier, ceilingNanos: input.ceilingNanos },
    { signal: abort.signal, intervalMs: input.dryRun ? 1 : 5000 },
  );
  const worker = input.ports.worker.wait(started.sessionId);
  const first = await Promise.race([watched.then((verdict) => ({ kind: 'watch' as const, verdict })), worker.then((result) => ({ kind: 'worker' as const, result }))]);

  let result: AttemptResult;
  let resultReason: string | null;
  let workerResult: WorkerResult | null = null;
  let tokens: TokenUsage | null = null;
  let estimatedCostNanos = 0;
  let costSource: LedgerRow['costSource'] = 'list-price';

  if (first.kind === 'watch' && first.verdict.action === 'stop') {
    abort.abort();
    result = 'stopped';
    resultReason = first.verdict.reason;
    tokens = first.verdict.tokens;
    estimatedCostNanos = first.verdict.costNanos;
    costSource = input.dryRun ? 'simulated' : first.verdict.costSource;
  } else {
    abort.abort();
    workerResult = first.kind === 'worker' ? first.result : await worker;
    const usage = await input.ports.usage.usageFor(started.sessionId);
    const check = checkCeiling(usage, { sessionId: started.sessionId, tier: input.tier, ceilingNanos: input.ceilingNanos });
    tokens = check.tokens;
    estimatedCostNanos = check.costNanos;
    costSource = input.dryRun ? 'simulated' : check.costSource;
    const verification = await input.ports.verifier.verify({
      checkoutPath: workerResult.checkoutPath ?? started.checkoutPath,
      branch: workerResult.branch ?? started.branch,
      repoPath: resolve(dirname(input.configPath), input.config.repo.path),
      config: input.config,
    });
    result = verification.passed ? 'passed' : 'failed';
    resultReason = verification.reason;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    attemptId: attemptId(input.runId, input.task.taskId, input.attempt),
    runId: input.runId,
    taskId: input.task.taskId,
    taskTitle: input.task.title,
    attempt: input.attempt,
    size: input.task.size,
    tier: input.tier.name,
    model: input.tier.model,
    harness: input.tier.harness,
    sessionId: started.sessionId,
    branch: input.dryRun ? null : (workerResult?.branch ?? started.branch),
    tokens: tokens ?? zeroTokens(),
    estimatedCostNanos,
    costSource,
    ceilingNanos: input.ceilingNanos ?? 0,
    result,
    resultReason,
    escalatedFrom: input.escalatedFrom,
    handoff: input.handoff,
    prUrl: input.dryRun ? null : (workerResult?.prUrl ?? null),
    traceUrl: null,
    checkpointId: null,
    checkpointUrl: null,
    decision: input.decision,
    startedAt,
    endedAt: input.now().toISOString(),
  };
}

export async function runRealTally(options: RealRunOptions): Promise<RunResult> {
  const config = loadConfig(options.configPath);
  const ports = { ...defaultPorts(config, options.configPath), ...options.ports };
  const now = options.now ?? (() => new Date());
  const started = now();
  const runId = runIdFrom(started);
  const mode: RunMode = options.baseline ? 'baseline' : 'tally';
  const outputDir = options.outputDir ? resolve(options.outputDir) : defaultOutputDir(runId);
  const ledgerPath = resolve(outputDir, 'ledger.json');
  const ledger = loadLedger(ledgerPath);
  let budgetLimitNanos = usdToNanos(options.budgetUsd ?? config.budget.usd);
  let budgetSource: BudgetSource = 'config';
  if (options.budgetUsd === undefined && config.budget.source === 'cfoai' && ports.cfoai) {
    try {
      budgetLimitNanos = await ports.cfoai.budgetLimitNanos();
      budgetSource = 'cfoai';
    } catch {
      budgetSource = 'config';
    }
  }
  const budget = new LedgerBudget(budgetLimitNanos, ledger);
  const recordSpend = async (row: LedgerRow) => {
    if (options.dryRun) return;
    const cumulative = ledgerSpend(ledger);
    appendCfoaiFallback(outputDir, row, cumulative);
    if (!config.integrations.cfoai || !ports.cfoai) return;
    try {
      await ports.cfoai.writeCumulativeActualSpend(cumulative);
    } catch {
      // CSV fallback has already preserved the attempted spend for a later sync.
    }
  };
  const tasks = (await ports.intake.tasks(config, options.configPath)).filter((task) => {
    if (options.only === undefined) return true;
    return task.taskId === options.only || String(task.issueNumber) === options.only;
  });
  const taskStates = tasks.map(initialTaskState);
  const writeCurrent = (status: RunState['status'], endedAt: string | null): RunState => {
    const updatedAt = now().toISOString();
    const runState: RunState = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      mode,
      dryRun: options.dryRun,
      status,
      repo: repoName(config),
      baseCommit: null,
      startedAt: started.toISOString(),
      updatedAt,
      endedAt,
      budget: {
        source: budgetSource,
        limitNanos: budgetLimitNanos,
        spentNanos: ledgerSpend(ledger),
      },
      tasks: taskStates,
      integrations: integrationStates(config, ports, { dryRun: options.dryRun, budgetSource }),
    };
    assertValid(runState, ledger);
    writeRunFiles(outputDir, runState, ledger, options.latestRunDir);
    return runState;
  };
  writeCurrent('running', null);

  for (const [index, task] of tasks.entries()) {
    const existingRows = ledger.filter((row) => row.taskId === task.taskId);
    if (isTaskDone(existingRows)) {
      taskStates[index] = stateFromRows(taskStates[index]!, existingRows);
      writeCurrent('running', null);
      continue;
    }
    const interrupted = existingRows[existingRows.length - 1];
    if (interrupted && interrupted.result !== 'passed' && interrupted.attempt === 1) {
      task.size = interrupted.size;
      let latest = interrupted;
      const escalation = await decideEscalation({
        previous: {
          attemptId: interrupted.attemptId,
          taskId: interrupted.taskId,
          attempt: interrupted.attempt,
          size: interrupted.size,
          tier: interrupted.tier,
          result: interrupted.result,
          sessionId: interrupted.sessionId,
        },
        config,
        ports: { budget, handoff: ports.handoff, trace: ports.trace },
      });
      if (escalation.action === 'escalate') {
        latest = await runAttempt({
          runId,
          task,
          attempt: 2,
          tier: escalation.tier,
          ceilingNanos: escalation.ceilingNanos,
          decision: escalation.reason,
          escalatedFrom: escalation.escalatedFrom,
          handoff: escalation.handoff,
          handoffSummary: escalation.handoffSummary,
          config,
          configPath: options.configPath,
          ports,
          now,
          dryRun: options.dryRun,
        });
        ledger.push(latest);
        await ports.history.record({ size: latest.size, tier: latest.tier, result: latest.result, costNanos: latest.estimatedCostNanos });
        await recordSpend(latest);
      } else {
        interrupted.resultReason = escalation.statusReason;
      }
      taskStates[index] = stateFromRows(taskStates[index]!, ledger.filter((row) => row.taskId === task.taskId));
      writeCurrent('running', null);
      continue;
    }
    const taskInput = { taskId: task.taskId, title: task.title, body: task.body };
    const estimate = await sizeTask(taskInput, { signals: ports.signals, trace: ports.trace });
    task.size = estimate.size;
    const route = options.baseline
      ? await routeBaseline({ task: taskInput, estimate, config, ports: { history: ports.history, budget, trace: ports.trace } })
      : await routeTask({ task: taskInput, estimate, config, ports: { history: ports.history, budget, trace: ports.trace } });
    const state = taskStates[index]!;
    state.size = estimate.size;
    if (route.action === 'skip') {
      state.status = 'skipped';
      state.statusReason = route.statusReason;
      writeCurrent('running', null);
      continue;
    }
    const first = await runAttempt({
      runId,
      task,
      attempt: 1,
      tier: route.tier,
      ceilingNanos: route.ceilingNanos,
      decision: route.reason,
      escalatedFrom: null,
      handoff: 'none',
      handoffSummary: null,
      config,
      configPath: options.configPath,
      ports,
      now,
      dryRun: options.dryRun,
    });
    ledger.push(first);
    await ports.history.record({ size: first.size, tier: first.tier, result: first.result, costNanos: first.estimatedCostNanos });
    await recordSpend(first);
    let latest = first;
    if (first.result !== 'passed') {
      const escalation = await decideEscalation({
        previous: {
          attemptId: first.attemptId,
          taskId: first.taskId,
          attempt: first.attempt,
          size: first.size,
          tier: first.tier,
          result: first.result,
          sessionId: first.sessionId,
        },
        config,
        ports: { budget, handoff: ports.handoff, trace: ports.trace },
      });
      if (escalation.action === 'escalate') {
        latest = await runAttempt({
          runId,
          task,
          attempt: 2,
          tier: escalation.tier,
          ceilingNanos: escalation.ceilingNanos,
          decision: escalation.reason,
          escalatedFrom: escalation.escalatedFrom,
          handoff: escalation.handoff,
          handoffSummary: escalation.handoffSummary,
          config,
          configPath: options.configPath,
          ports,
          now,
          dryRun: options.dryRun,
        });
        ledger.push(latest);
        await ports.history.record({ size: latest.size, tier: latest.tier, result: latest.result, costNanos: latest.estimatedCostNanos });
        await recordSpend(latest);
      } else {
        latest.resultReason = escalation.statusReason;
      }
    }
    const rows = ledger.filter((row) => row.taskId === task.taskId);
    state.status = statusFrom(latest.result);
    state.statusReason = latest.resultReason;
    state.attempts = latest.attempt;
    state.tier = latest.tier;
    state.model = latest.model;
    state.spentNanos = rows.reduce((sum, row) => sum + row.estimatedCostNanos, 0);
    state.escalated = latest.escalatedFrom !== null;
    state.prUrl = latest.prUrl;
    writeCurrent('running', null);
  }

  const endedAt = now().toISOString();
  const runState = writeCurrent('finished', endedAt);
  await (ports.trace as (TracePort & { flush?: () => Promise<void> }) | undefined)?.flush?.();
  const paths = writeRunFiles(outputDir, runState, ledger, options.latestRunDir);
  return { runState, ledger, ...paths };
}
