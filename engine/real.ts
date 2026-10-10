import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { routeBaseline } from '../agent/baseline.js';
import { decideEscalation } from '../agent/escalation.js';
import type {
  BudgetPort,
  CheckpointRecallPort,
  CheckpointPort,
  HandoffPort,
  LiveUsagePort,
  PriceHistoryPort,
  PriceHistoryWriterPort,
  SessionControlPort,
  SizingSignalsPort,
  TracePort,
} from '../agent/ports.js';
import { routeTask } from '../agent/router.js';
import { applyCheckpointRecall, sizeTask } from '../agent/sizer.js';
import { checkCeiling, CeilingWatcher } from '../agent/watcher.js';
import { AoCliAdapter } from '../adapters/ao.js';
import { CfoaiBudgetAdapter, CFOAI_FIX_COMMAND } from '../adapters/cfoai.js';
import { EntireSizingAdapter } from '../adapters/entire.js';
import { EntireCheckpointAdapter } from '../adapters/entire-checkpoints.js';
import { EntireCheckpointRecallAdapter } from '../adapters/entire-recall.js';
import { type BacklogIntakePort, ConfigBacklogIntake } from '../adapters/github.js';
import { FilePriceHistory } from '../adapters/history-file.js';
import { historyAttributes, historyTraceName, NeatlogsPriceHistory } from '../adapters/neatlogs-history.js';
import { NeatlogsTraceAdapter } from '../adapters/neatlogs.js';
import { GitHubPublisher, type PublishPort } from '../adapters/publisher.js';
import { outOfScopeFiles } from './scope.js';
import { CommandVerifier, EntireGraphVerifier, type VerifierPort } from '../adapters/verifier.js';
import { attemptId, SCHEMA_VERSION, usdToNanos, validateLedger, validateRunState } from '../schema/index.js';
import type { AttemptResult, BudgetSource, IntegrationState, Ledger, LedgerRow, RunMode, RunState, TaskState, TallyConfig, Tier, TokenUsage } from '../schema/index.js';
import { type BacklogTask } from './backlog.js';
import { loadConfig } from './config.js';
import { writeRunFiles } from './output.js';
import type { RunOptions, RunResult } from './run.js';

const execFileAsync = promisify(execFile);

export interface WorkerStartInput {
  task: BacklogTask;
  attempt: number;
  tier: Tier;
  ceilingNanos: number | null;
  harness: string;
  sessionMode?: 'chat' | 'tui';
  model: string;
  name: string;
  prompt: string;
  aoProject?: string;
}

export interface WorkerResult {
  status: 'idle' | 'terminated' | 'needs_input' | 'timeout' | 'experiment_stop';
  branch: string | null;
  checkoutPath: string | null;
  prUrl: string | null;
  resultReason?: string | null;
}

export interface WorkerPort {
  start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string | null; checkoutPath: string | null }>;
  wait(sessionId: string, options?: { timeoutMs?: number }): Promise<WorkerResult>;
}

export interface FinalUsagePort extends LiveUsagePort {
  settledUsageFor?(sessionId: string): Promise<Awaited<ReturnType<LiveUsagePort['usageFor']>>>;
}

export interface WorktreePort {
  checkoutPathFor(repoPath: string, branch: string): Promise<string | null>;
  commitFor?(repoPath: string, branch: string): Promise<string | null>;
}

export interface CfoaiBudgetPort extends BudgetPort {
  budgetLimitNanos(): Promise<number>;
  currentSpendNanos?(): Promise<number>;
  writeCumulativeActualSpend(runSpendNanos: number): Promise<void>;
  writeSpendDetail?(input: { attempts: Array<{ tier: string; costNanos: number }>; cumulativeRunSpendNanos: number }): Promise<{ skippedTiers: string[] }>;
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
  recall?: CheckpointRecallPort;
  handoff?: HandoffPort;
  checkpoints?: CheckpointPort;
  trace?: TracePort;
  cfoai?: CfoaiBudgetPort;
  publisher: PublishPort;
  worktrees: WorktreePort;
}

export interface RealRunOptions extends RunOptions {
  ports?: Partial<RealRunPorts>;
}

export class GitWorktreeResolver implements WorktreePort {
  async commitFor(repoPath: string, branch: string): Promise<string | null> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`], { cwd: repoPath });
    return stdout.trim();
  }
  async checkoutPathFor(repoPath: string, branch: string): Promise<string | null> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    let worktree: string | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktree = line.slice('worktree '.length);
        continue;
      }
      if (line === `branch refs/heads/${branch}` || line === `branch refs/remotes/origin/${branch}`) return worktree;
    }
    return null;
  }
}

class LedgerBudget implements BudgetPort {
  reservedNanos = 0;

  constructor(
    private readonly limitNanos: number,
    private readonly ledger: Ledger,
    private readonly committedBeforeRunNanos = 0,
  ) {}

  async remainingNanos(): Promise<number> {
    const spent = this.ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0);
    return this.limitNanos - this.committedBeforeRunNanos - spent - this.reservedNanos;
  }
}

const nullSignals: SizingSignalsPort = {
  async signalsFor() {
    return null;
  },
};

function hasPort<K extends keyof RealRunPorts>(ports: Partial<RealRunPorts>, key: K): ports is Partial<RealRunPorts> & Pick<RealRunPorts, K> {
  return Object.prototype.hasOwnProperty.call(ports, key);
}

function resolvePorts(config: TallyConfig, configPath: string, overrides: Partial<RealRunPorts> = {}): RealRunPorts {
  const ao = new AoCliAdapter();
  const configDir = dirname(configPath);
  const repoPath = resolve(configDir, config.repo.path);
  const localHistory = hasPort(overrides, 'history') ? null : new FilePriceHistory({ path: resolve(configDir, '.tally', 'history.json') });
  const trace = hasPort(overrides, 'trace') ? overrides.trace : config.integrations.neatlogs ? new NeatlogsTraceAdapter() : undefined;
  const cfoai = hasPort(overrides, 'cfoai')
    ? overrides.cfoai
    : config.integrations.cfoai || config.budget.source === 'cfoai'
      ? new CfoaiBudgetAdapter({ config: config.budget.cfoai })
      : undefined;
  const entireCheckpoints =
    config.integrations.entire && (!hasPort(overrides, 'handoff') || !hasPort(overrides, 'checkpoints'))
      ? new EntireCheckpointAdapter({ repoPath, generatedSummaries: config.entire?.generatedSummaries })
      : undefined;
  const handoff = overrides.handoff ?? entireCheckpoints;
  const checkpoints = overrides.checkpoints ?? entireCheckpoints;
  const recall = overrides.recall ?? (config.integrations.entire ? new EntireCheckpointRecallAdapter({ repoPath }) : undefined);
  return {
    intake: overrides.intake ?? new ConfigBacklogIntake(),
    signals: overrides.signals ?? (config.integrations.entire ? new EntireSizingAdapter({ repoPath }) : nullSignals),
    worker: overrides.worker ?? ao,
    verifier: overrides.verifier ?? (config.integrations.entire ? new EntireGraphVerifier() : new CommandVerifier()),
    usage: overrides.usage ?? ao,
    sessions: overrides.sessions ?? ao,
    history: overrides.history ?? (config.integrations.neatlogs ? new NeatlogsPriceHistory({ fallback: localHistory! }) : localHistory!),
    ...(recall ? { recall } : {}),
    publisher: overrides.publisher ?? new GitHubPublisher(),
    worktrees: overrides.worktrees ?? new GitWorktreeResolver(),
    ...(handoff ? { handoff } : {}),
    ...(checkpoints ? { checkpoints } : {}),
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

function lastTraceId(trace: TracePort | undefined): string | null {
  const withTraceId = trace as (TracePort & { lastTraceId?: () => string | null }) | undefined;
  return withTraceId?.lastTraceId?.() ?? null;
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

function promptFor(task: BacklogTask, config: TallyConfig, tier: Tier, handoffSummary: string | null, runId: string, attempt: number): string {
  const setup = config.test.setupCommand
    ? [
        `The environment has already been set up before you started. Do not run setup (${config.test.setupCommand}), install dependencies, or use the network.`,
      ]
    : ['Do not install dependencies or use the network unless the task explicitly requires it.'];
  const publishInstruction = config.repo.workerPublishesPr
    ? 'Commit your changes on your current branch, push that branch, open a pull request against the default branch, and do not merge it.'
    : 'Commit your changes on your current branch, but do not push and do not open a pull request; Tally will publish the verified branch.';
  return [
    `You are implementing Tally run ${runId}, task ${task.taskId}, attempt ${attempt}: ${task.title}`,
    `Neatlogs correlation: runId=${runId} taskId=${task.taskId} attempt=${attempt}.`,
    '',
    'You are already inside your own AO git worktree for the target repo. Work only in the current working directory.',
    'Never read or write any other checkout or path outside this worktree; this worktree is the authoritative target repo.',
    publishInstruction,
    'Change only what this task needs. Do not add or edit CI, deployment, or tooling config unless the task explicitly asks for it. If a check outside your task fails, report it; do not fix it.',
    '',
    task.body || '(No issue body was provided.)',
    '',
    `Target repo: ${repoName(config)}`,
    ...setup,
    `Run this verification command before claiming success: ${config.test.command}`,
    `You are running on tier ${tier.name} (${tier.harness}/${tier.model}).`,
    handoffSummary ? `\nHandoff from the previous attempt:\n${handoffSummary}` : '',
  ].join('\n');
}

function zeroTokens(): TokenUsage {
  return { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
}

function hasUsage(tokens: TokenUsage): boolean {
  return tokens.total > 0 || tokens.uncachedInput > 0 || tokens.cachedInput > 0 || tokens.output > 0;
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

async function recordHistory(input: { ports: RealRunPorts; row: LedgerRow; dryRun: boolean }): Promise<void> {
  const outcome = { size: input.row.size, tier: input.row.tier, result: input.row.result, costNanos: input.row.estimatedCostNanos };
  await input.ports.history.record(outcome);
  if (input.dryRun || !input.ports.trace) return;
  await input.ports.trace.span(
    historyTraceName(outcome),
    {
      sessionId: input.row.runId,
      taskId: input.row.taskId,
      attempt: input.row.attempt,
      model: input.row.model,
      ...historyAttributes(outcome),
    },
    async () => {},
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
  traceId: string | null;
  config: TallyConfig;
  configPath: string;
  ports: RealRunPorts;
  now: () => Date;
  dryRun: boolean;
  baseCommit?: string | null;
  requiredBaseCommit?: string;
  continueBranch?: string | null;
  onChangedFiles?: (files: string[]) => void;
}): Promise<LedgerRow> {
  const startedAt = input.now().toISOString();
  const repoPath = resolve(dirname(input.configPath), input.config.repo.path);
  const attemptBase = input.requiredBaseCommit ?? (input.dryRun ? null : await input.ports.worktrees.commitFor?.(repoPath, input.continueBranch ?? input.config.repo.baseBranch).catch(() => null) ?? input.baseCommit ?? null);
  const started = await input.ports.worker.start({
    task: input.task,
    attempt: input.attempt,
    tier: input.tier,
    ceilingNanos: input.ceilingNanos,
    harness: input.tier.harness,
    sessionMode: input.tier.sessionMode,
    model: input.tier.model,
    name: `tally-${input.runId}-${input.task.taskId}-${input.attempt}`,
    prompt: promptFor(input.task, input.config, input.tier, input.handoffSummary, input.runId, input.attempt),
    aoProject: input.config.repo.aoProject,
  });
  let stopped = false;
  const watcher = new CeilingWatcher({ usage: input.ports.usage, sessions: input.ports.sessions, trace: input.ports.trace });
  const abort = new AbortController();
  const watched = watcher.watch(
    { sessionId: started.sessionId, tier: input.tier, ceilingNanos: input.ceilingNanos },
    { signal: abort.signal, intervalMs: input.dryRun ? 1 : 5000 },
  );
  const worker = input.ports.worker.wait(started.sessionId, { timeoutMs: input.config.test.timeoutSec ? input.config.test.timeoutSec * 1000 : undefined });
  let result: AttemptResult = 'error';
  let resultReason: string | null = null;
  let workerResult: WorkerResult | null = null;
  let tokens: TokenUsage | null = null;
  let estimatedCostNanos = 0;
  let costSource: LedgerRow['costSource'] = 'list-price';
  let prUrl: string | null = null;
  let checkpointId: string | null = null;
  let checkpointUrl: string | null = null;
  let scopeWarnings: string[] = [];
  let entireSessionId: string | null = null;
  let resolvedCheckoutPath: string | null = null;

  try {
  const first = await Promise.race([watched.then((verdict) => ({ kind: 'watch' as const, verdict })), worker.then((result) => ({ kind: 'worker' as const, result }))]);
  if (first.kind === 'watch' && first.verdict.action === 'stop') {
    stopped = first.verdict.stopped;
    abort.abort();
    if (!input.dryRun) workerResult = await worker;
    result = 'stopped';
    resultReason = first.verdict.reason;
    tokens = first.verdict.tokens;
    estimatedCostNanos = first.verdict.costNanos;
    costSource = input.dryRun ? 'simulated' : first.verdict.costSource;
  } else {
    abort.abort();
    workerResult = first.kind === 'worker' ? first.result : await worker;
    if (workerResult.status === 'experiment_stop') {
      result = 'stopped';
      resultReason = workerResult.resultReason ?? 'stopped: experiment cap reached';
    } else if (workerResult.status === 'needs_input' || workerResult.status === 'timeout') {
      result = 'error';
      resultReason = workerResult.resultReason ?? (workerResult.status === 'timeout' ? 'worker exceeded wall-clock limit' : 'worker asked for input');
    } else {
      let checkoutPath = workerResult.checkoutPath ?? started.checkoutPath;
      const branch = workerResult.branch ?? started.branch;
      if (!input.dryRun && !checkoutPath && branch) {
        checkoutPath = await input.ports.worktrees.checkoutPathFor(resolve(dirname(input.configPath), input.config.repo.path), branch);
      }
      resolvedCheckoutPath = checkoutPath;
      if (!input.dryRun && (!checkoutPath || !branch)) {
        result = 'error';
        resultReason = 'could not locate worker checkout';
      } else if (!input.dryRun && (await input.ports.publisher.commitsAhead({ checkoutPath: checkoutPath!, branch: branch!, config: input.config })) <= 0) {
        result = 'failed';
        resultReason = 'no changes made';
      } else {
        const verification = await input.ports.verifier.verify({
          checkoutPath,
          branch,
          repoPath: resolve(dirname(input.configPath), input.config.repo.path),
          config: input.config,
        });
        result = verification.passed ? 'passed' : 'failed';
        resultReason = verification.reason;
        if (verification.passed && !input.dryRun) {
          scopeWarnings = outOfScopeFiles(input.task, await input.ports.publisher.changedFiles({ checkoutPath: checkoutPath!, branch: branch!, config: input.config, baseCommit: attemptBase }));
          if (scopeWarnings.length && input.config.repo.blockOutOfScopeChanges) {
            result = 'error';
            resultReason = `out-of-scope changes: ${scopeWarnings.join(', ')}`;
          } else if (input.config.repo.workerPublishesPr) {
            prUrl = workerResult.prUrl;
            if (!prUrl) {
              result = 'failed';
              resultReason = 'worker finished without opening a PR';
            }
          } else {
            try {
              prUrl = await input.ports.publisher.publishPr({
                checkoutPath: checkoutPath!,
                branch: branch!,
                config: input.config,
                task: input.task,
                runId: input.runId,
                attempt: input.attempt,
                scopeWarnings,
              });
            } catch (error) {
              result = 'failed';
              const message = error instanceof Error ? error.message : String(error);
              resultReason = `PR publish failed: ${message}`;
            }
          }
        }
      }
    }
  }
  if (!input.dryRun && input.ports.checkpoints) {
    const branch = workerResult?.branch ?? started.branch;
    const checkoutPath = resolvedCheckoutPath ?? workerResult?.checkoutPath ?? started.checkoutPath ?? (branch
      ? await input.ports.worktrees.checkoutPathFor(resolve(dirname(input.configPath), input.config.repo.path), branch).catch(() => null)
      : null);
    try {
      const checkpoint = await input.ports.checkpoints.checkpointFor({ sessionId: started.sessionId, branch, checkoutPath });
      checkpointId = checkpoint?.checkpointId ?? null;
      checkpointUrl = checkpoint?.checkpointUrl ?? null;
      entireSessionId = checkpoint?.entireSessionId ?? null;
    } catch {
      checkpointId = null;
      checkpointUrl = null;
    }
  }
  } catch (error) {
    result = 'error';
    resultReason = error instanceof Error ? error.message : String(error);
  } finally {
    abort.abort();
    if (!stopped) {
      try {
        await input.ports.sessions.stop(started.sessionId, `Tally attempt finished: ${result}`);
      } catch (error) {
        throw new Error(`could not close worker ${started.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await watched;
  }
  const usagePort = input.ports.usage as FinalUsagePort;
  const finalUsage = usagePort.settledUsageFor ? await usagePort.settledUsageFor(started.sessionId) : await usagePort.usageFor(started.sessionId);
  if (finalUsage) {
    const finalCheck = checkCeiling(finalUsage, { sessionId: started.sessionId, tier: input.tier, ceilingNanos: input.ceilingNanos });
    tokens = finalCheck.tokens;
    estimatedCostNanos = finalCheck.costNanos;
    costSource = input.dryRun ? 'simulated' : finalCheck.costSource;
  }

  if (!input.dryRun && workerResult?.branch && input.onChangedFiles) {
    const checkoutPath = resolvedCheckoutPath ?? workerResult.checkoutPath ?? started.checkoutPath ?? await input.ports.worktrees.checkoutPathFor(repoPath, workerResult.branch).catch(() => null);
    if (checkoutPath) {
      const files = await input.ports.publisher.changedFiles({ checkoutPath, branch: workerResult.branch, config: input.config, baseCommit: attemptBase }).catch(() => null);
      if (files) input.onChangedFiles(files);
    }
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
    entireSessionId,
    branch: input.dryRun ? null : (workerResult?.branch ?? started.branch),
    baseCommit: attemptBase,
    tokens: tokens ?? zeroTokens(),
    estimatedCostNanos,
    costSource,
    ceilingNanos: input.ceilingNanos ?? 0,
    result,
    resultReason,
    scopeWarnings,
    escalatedFrom: input.escalatedFrom,
    handoff: input.handoff,
    prUrl: input.dryRun ? null : prUrl,
    traceId: input.traceId,
    traceUrl: null,
    checkpointId,
    checkpointUrl,
    decision: input.decision,
    startedAt,
    endedAt: input.now().toISOString(),
  };
}

function handoffSummaryLedgerRow(input: {
  runId: string;
  task: BacklogTask;
  previous: LedgerRow;
  decision: {
    handoffSummaryCostNanos: number;
    handoffSummaryCostSource: LedgerRow['costSource'];
    handoffSummaryTokens: TokenUsage;
    checkpointId: string | null;
    checkpointUrl: string | null;
  };
  traceId: string | null;
  now: () => Date;
}): LedgerRow | null {
  if (input.decision.handoffSummaryCostNanos <= 0 && !hasUsage(input.decision.handoffSummaryTokens)) return null;
  const timestamp = input.now().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    attemptId: `${attemptId(input.runId, input.task.taskId, input.previous.attempt + 1)}:handoff`,
    runId: input.runId,
    taskId: `${input.task.taskId}:handoff`,
    taskTitle: `${input.task.title} - Entire handoff summary`,
    attempt: input.previous.attempt + 1,
    size: input.previous.size,
    tier: 'entire-handoff',
    model: 'entire checkpoint explain',
    harness: 'entire',
    sessionId: input.previous.sessionId,
    entireSessionId: input.previous.entireSessionId ?? null,
    branch: input.previous.branch,
    tokens: input.decision.handoffSummaryTokens,
    estimatedCostNanos: input.decision.handoffSummaryCostNanos,
    costSource: input.decision.handoffSummaryCostSource,
    ceilingNanos: 0,
    result: 'passed',
    resultReason: 'Entire checkpoint summary generated for escalation',
    escalatedFrom: input.previous.attemptId,
    handoff: 'entire-handoff',
    prUrl: null,
    traceId: input.traceId,
    traceUrl: null,
    checkpointId: input.decision.checkpointId,
    checkpointUrl: input.decision.checkpointUrl,
    decision: `Entire generated a checkpoint handoff summary for ${input.task.taskId} before escalation.`,
    startedAt: timestamp,
    endedAt: timestamp,
  };
}

export async function runRealTally(options: RealRunOptions): Promise<RunResult> {
  const config = loadConfig(options.configPath);
  const ports = resolvePorts(config, options.configPath, options.ports);
  const now = options.now ?? (() => new Date());
  const started = now();
  const runId = options.runId ?? runIdFrom(started);
  const mode: RunMode = options.baseline ? 'baseline' : 'tally';
  const outputDir = options.outputDir ? resolve(options.outputDir) : defaultOutputDir(runId);
  const ledgerPath = resolve(outputDir, 'ledger.json');
  const ledger = loadLedger(ledgerPath);
  let budgetLimitNanos = usdToNanos(options.budgetUsd ?? config.budget.usd);
  let budgetSource: BudgetSource = 'config';
  let committedBeforeRunNanos = 0;
  if ((config.integrations.cfoai || config.budget.source === 'cfoai') && ports.cfoai) {
    try {
      const [limit, currentSpend] = await Promise.all([ports.cfoai.budgetLimitNanos(), ports.cfoai.currentSpendNanos?.() ?? Promise.resolve(0)]);
      if (options.budgetUsd === undefined && config.budget.source === 'cfoai') {
        budgetLimitNanos = limit;
        committedBeforeRunNanos = Math.max(0, currentSpend - ledgerSpend(ledger));
        budgetSource = 'cfoai';
      }
    } catch {
      budgetSource = 'config';
    }
  }
  const budget = new LedgerBudget(budgetLimitNanos, ledger, committedBeforeRunNanos);
  const recordSpend = async (row: LedgerRow) => {
    if (options.dryRun) return;
    const cumulative = ledgerSpend(ledger);
    appendCfoaiFallback(outputDir, row, cumulative);
    if (!config.integrations.cfoai || !ports.cfoai) return;
    try {
      await ports.cfoai.writeCumulativeActualSpend(cumulative);
      await ports.cfoai.writeSpendDetail?.({
        attempts: ledger.map((attempt) => ({ tier: attempt.tier, costNanos: attempt.estimatedCostNanos })),
        cumulativeRunSpendNanos: cumulative,
      });
    } catch {
      // CSV fallback has already preserved the attempted spend for a later sync.
    }
  };
  const tasks = (await ports.intake.tasks(config, options.configPath)).filter((task) => {
    if (options.only === undefined) return true;
    return task.taskId === options.only || String(task.issueNumber) === options.only;
  });
  const savedRun = existsSync(resolve(outputDir, 'run.json')) ? JSON.parse(readFileSync(resolve(outputDir, 'run.json'), 'utf8')) as RunState : null;
  const resolvedBase = options.requiredBaseCommit !== undefined || (!savedRun?.baseCommit && !options.dryRun)
    ? await ports.worktrees.commitFor?.(resolve(dirname(options.configPath), config.repo.path), config.repo.baseBranch).catch(() => null) ?? null
    : null;
  if (options.requiredBaseCommit !== undefined) {
    if (resolvedBase !== options.requiredBaseCommit) {
      throw new Error(`Required base commit ${options.requiredBaseCommit} does not match resolved ${config.repo.baseBranch} base ${resolvedBase ?? '(unavailable)'}; no workers were started.`);
    }
    if (savedRun?.baseCommit && savedRun.baseCommit !== options.requiredBaseCommit) {
      throw new Error(`Saved run base ${savedRun.baseCommit} does not match required base commit ${options.requiredBaseCommit}; no workers were started.`);
    }
  }
  const baseCommit = options.requiredBaseCommit ?? savedRun?.baseCommit ?? resolvedBase;
  const taskStates = tasks.map((task) => {
    const saved = savedRun?.tasks.find((state) => state.taskId === task.taskId);
    return { ...initialTaskState(task), ...(saved?.impact ? { impact: saved.impact } : {}), ...(saved?.changedFiles ? { changedFiles: saved.changedFiles } : {}) };
  });
  const changedFor = (index: number) => (files: string[]) => {
    const state = taskStates[index]!;
    state.changedFiles = [...new Set([...(state.changedFiles ?? []), ...files])].sort();
    writeCurrent('running', null);
  };
  const writeCurrent = (status: RunState['status'], endedAt: string | null): RunState => {
    const updatedAt = now().toISOString();
    const runState: RunState = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      mode,
      ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
      dryRun: options.dryRun,
      status,
      repo: repoName(config),
      baseCommit,
      startedAt: started.toISOString(),
      updatedAt,
      endedAt,
      budget: {
        source: budgetSource,
        limitSource: options.budgetUsd === undefined ? budgetSource : 'cli',
        systemOfRecord: config.integrations.cfoai && ports.cfoai ? 'cfoai' : 'ledger',
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
    const stopReason = options.stopRequested?.();
    if (stopReason) {
      for (const state of taskStates.slice(index)) {
        state.status = 'skipped';
        state.statusReason = stopReason;
      }
      break;
    }
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
      if (interrupted.result !== 'error') {
        const escalation = await decideEscalation({
          previous: {
            attemptId: interrupted.attemptId,
            taskId: interrupted.taskId,
            attempt: interrupted.attempt,
            size: interrupted.size,
            tier: interrupted.tier,
            result: interrupted.result,
            sessionId: interrupted.sessionId,
            branch: interrupted.branch,
            checkpointId: interrupted.checkpointId,
            resultReason: interrupted.resultReason,
          },
          task,
          config,
          ports: { budget, handoff: ports.handoff, trace: ports.trace },
          traceAttributes: { sessionId: runId, taskId: interrupted.taskId, attempt: interrupted.attempt + 1 },
        });
        const escalationTraceId = lastTraceId(ports.trace);
        if (escalation.action === 'escalate') {
          const summaryRow = handoffSummaryLedgerRow({ runId, task, previous: interrupted, decision: escalation, traceId: escalationTraceId, now });
          if (summaryRow) {
            ledger.push(summaryRow);
            await recordSpend(summaryRow);
          }
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
            traceId: escalationTraceId,
            config,
            configPath: options.configPath,
            ports,
            now,
            dryRun: options.dryRun,
            baseCommit,
            requiredBaseCommit: options.requiredBaseCommit,
            continueBranch: escalation.handoffBranch,
            onChangedFiles: changedFor(index),
          });
          ledger.push(latest);
          await recordHistory({ ports, row: latest, dryRun: options.dryRun });
          await recordSpend(latest);
        } else {
          interrupted.resultReason = escalation.statusReason;
        }
      }
      taskStates[index] = stateFromRows(taskStates[index]!, ledger.filter((row) => row.taskId === task.taskId));
      writeCurrent('running', null);
      continue;
    }
    const taskInput = { taskId: task.taskId, title: task.title, body: task.body };
    const sized = await sizeTask(taskInput, { signals: ports.signals, trace: ports.trace });
    let estimate = sized;
    if (ports.recall) {
      try {
        estimate = applyCheckpointRecall(sized, await ports.recall.recallFor(taskInput));
      } catch {
        estimate = sized;
      }
    }
    task.size = estimate.size;
    const state = taskStates[index]!;
    state.size = estimate.size;
    state.impact ??= structuredClone(estimate.signals?.impact ?? {
      source: estimate.signals?.source ?? 'none', query: `${task.title}\n${task.body}`.trim(), nodes: [], edges: [],
      totals: { filesTouched: estimate.signals?.filesTouched ?? 0, dependents: estimate.signals?.dependents ?? 0, testsPresent: estimate.signals?.testsPresent ?? false, nodes: 0, edges: 0 }, truncated: false,
    });
    writeCurrent('running', null);
    const route = options.baseline
      ? await routeBaseline({
          task: taskInput,
          estimate,
          config,
          ports: { history: ports.history, budget, trace: ports.trace },
          traceAttributes: { sessionId: runId, taskId: task.taskId, attempt: 1 },
        })
      : await routeTask({
          task: taskInput,
          estimate,
          config,
          ports: { history: ports.history, budget, trace: ports.trace },
          traceAttributes: { sessionId: runId, taskId: task.taskId, attempt: 1 },
        });
    const routeTraceId = lastTraceId(ports.trace);
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
      ceilingNanos: task.firstAttemptCeilingUsd === undefined || options.baseline ? route.ceilingNanos : Math.min(route.ceilingNanos ?? Infinity, usdToNanos(task.firstAttemptCeilingUsd)),
      decision: task.firstAttemptCeilingUsd === undefined || options.baseline ? route.reason : `${route.reason} Deliberate first-attempt ceiling override: $${task.firstAttemptCeilingUsd.toFixed(3)} (normal ceiling remains an upper bound).`,
      escalatedFrom: null,
      handoff: 'none',
      handoffSummary: null,
      traceId: routeTraceId,
      config,
      configPath: options.configPath,
      ports,
      now,
      dryRun: options.dryRun,
      baseCommit,
      requiredBaseCommit: options.requiredBaseCommit,
      onChangedFiles: changedFor(index),
    });
    ledger.push(first);
    if (first.result === 'stopped' && options.stopRequested?.()) first.resultReason = options.stopRequested()!;
    await recordHistory({ ports, row: first, dryRun: options.dryRun });
    await recordSpend(first);
    let latest = first;
    if (first.result !== 'passed' && first.result !== 'error' && !options.stopRequested?.()) {
      const escalation = await decideEscalation({
        previous: {
          attemptId: first.attemptId,
          taskId: first.taskId,
          attempt: first.attempt,
          size: first.size,
          tier: first.tier,
          result: first.result,
          sessionId: first.sessionId,
          branch: first.branch,
          checkpointId: first.checkpointId,
          resultReason: first.resultReason,
        },
        task,
        config,
        ports: { budget, handoff: ports.handoff, trace: ports.trace },
        traceAttributes: { sessionId: runId, taskId: first.taskId, attempt: 2 },
      });
      const escalationTraceId = lastTraceId(ports.trace);
      if (escalation.action === 'escalate') {
        const summaryRow = handoffSummaryLedgerRow({ runId, task, previous: first, decision: escalation, traceId: escalationTraceId, now });
        if (summaryRow) {
          ledger.push(summaryRow);
          await recordSpend(summaryRow);
        }
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
          traceId: escalationTraceId,
          config,
          configPath: options.configPath,
          ports,
          now,
          dryRun: options.dryRun,
          baseCommit,
          requiredBaseCommit: options.requiredBaseCommit,
          continueBranch: escalation.handoffBranch,
          onChangedFiles: changedFor(index),
        });
        ledger.push(latest);
        await recordHistory({ ports, row: latest, dryRun: options.dryRun });
        await recordSpend(latest);
      } else {
        latest.resultReason = latest.result === 'error' && latest.resultReason ? latest.resultReason : escalation.statusReason;
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
  const runState = writeCurrent(options.stopRequested?.() ? 'interrupted' : 'finished', endedAt);
  await (ports.trace as (TracePort & { flush?: () => Promise<void> }) | undefined)?.flush?.();
  const paths = writeRunFiles(outputDir, runState, ledger, options.latestRunDir);
  return { runState, ledger, ...paths };
}
