import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { runCommand } from '../adapters/command.js';
import { dirname, resolve } from 'node:path';
import { routeBaseline } from '../agent/baseline.js';
import { decideEscalation } from '../agent/escalation.js';
import type {
  BudgetPort,
  CheckpointRecallPort,
  CheckpointPort,
  HandoffPort,
  LiveUsage,
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
import { createDirectRunner } from '../adapters/direct-codex.js';
import { workerCorrelationPrefix } from './worker-correlation.js';
import { CfoaiBudgetAdapter, CFOAI_FIX_COMMAND } from '../adapters/cfoai.js';
import { EntireSizingAdapter } from '../adapters/entire.js';
import { RepositorySizingAdapter } from '../adapters/repository-sizing.js';
import { EntireCheckpointAdapter } from '../adapters/entire-checkpoints.js';
import { NeatlogsWorkerSpoolAdapter, type WorkerTraceDrainPort } from '../adapters/neatlogs-worker-spool.js';
import { NeatlogsWorkerTraceReader, type WorkerTraceReaderPort } from '../adapters/neatlogs-worker-traces.js';
import { EntireCheckpointRecallAdapter } from '../adapters/entire-recall.js';
import { type BacklogIntakePort, ConfigBacklogIntake } from '../adapters/github.js';
import { historyAttributes, historyTraceName } from '../adapters/neatlogs-history.js';
import { NeatlogsTraceAdapter } from '../adapters/neatlogs.js';
import { GitHubPublisher, type PublishPort } from '../adapters/publisher.js';
import { outOfScopeFiles } from './scope.js';
import { CommandVerifier, EntireGraphVerifier, type VerifierPort } from '../adapters/verifier.js';
import { attemptId, ceilingNanos, SCHEMA_VERSION, usdToNanos, validateLedger, validateRunState } from '../schema/index.js';
import type { AttemptResult, BudgetSource, IntegrationState, Ledger, LedgerRow, RunMode, RunState, TaskState, TallyConfig, Tier, TokenUsage } from '../schema/index.js';
import { type BacklogTask } from './backlog.js';
import { ConfigError, loadConfig } from './config.js';
import { modelAccessConfigurationError } from './model-access.js';
import { createPriceHistory } from './price-history.js';
import { writeRunFiles } from './output.js';
import { tierPriceNote } from './pricing.js';
import { RunError, type RunOptions, type RunResult } from './run.js';
import { Reservations, runPool, SerialQueue } from './concurrency.js';

const execFileAsync = runCommand;

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
  continueBranch?: string | null;
  continueSessionId?: string | null;
}

export interface WorkerResult {
  status: 'idle' | 'terminated' | 'needs_input' | 'timeout' | 'experiment_stop' | 'never_started' | 'error';
  branch: string | null;
  checkoutPath: string | null;
  prUrl: string | null;
  resultReason?: string | null;
  permissionWarnings?: string[];
}

export interface WorkerPort {
  start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string | null; checkoutPath: string | null; setupDurationMs?: number }>;
  wait(sessionId: string, options?: { timeoutMs?: number }): Promise<WorkerResult>;
  /** Optional scripted evidence, read only once this attempt has settled. */
  changedFilesFor?(sessionId: string): Promise<string[] | null>;
  release?(sessionId: string): Promise<void>;
  /** Host commits uncommitted task edits after normal direct-worker completion. */
  commitChanges?(sessionId: string): Promise<string | null>;
}

export interface FinalUsagePort extends LiveUsagePort {
  settledUsageFor?(sessionId: string): Promise<Awaited<ReturnType<LiveUsagePort['usageFor']>>>;
}

export interface WorktreePort {
  checkoutPathFor(repoPath: string, branch: string): Promise<string | null>;
  commitFor?(repoPath: string, branch: string): Promise<string | null>;
  commitWorkInProgress?(repoPath: string, branch: string): Promise<string | null>;
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
  workerTraceDrain?: WorkerTraceDrainPort;
  workerTraceReader?: WorkerTraceReaderPort;
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
  async commitWorkInProgress(repoPath: string, branch: string): Promise<string | null> {
    const cwd = await this.checkoutPathFor(repoPath, branch);
    if (!cwd) return null;
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    if (!status.stdout.trim()) return null;
    await execFileAsync('git', ['add', '-A'], { cwd });
    await execFileAsync('git', ['commit', '-m', 'wip: preserve Tally ceiling-stopped task edits'], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return this.commitFor(repoPath, branch);
  }
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

function hasPort<K extends keyof RealRunPorts>(ports: Partial<RealRunPorts>, key: K): ports is Partial<RealRunPorts> & Pick<RealRunPorts, K> {
  return Object.prototype.hasOwnProperty.call(ports, key);
}

function resolvePorts(config: TallyConfig, configPath: string, overrides: Partial<RealRunPorts> = {}, requiredBaseCommit?: string): RealRunPorts {
  const configDir = dirname(configPath);
  const repoPath = resolve(configDir, config.repo.path);
  const runner = config.runner === 'direct'
    ? createDirectRunner({ repoPath, baseBranch: config.repo.baseBranch, configPath: resolve(configPath), test: config.test, requiredBaseCommit, approvedRules: config.claudeCode?.allow })
    : new AoCliAdapter({ cwd: repoPath, project: config.repo.aoProject, aoBin: config.repo.aoBin ? resolve(configDir, config.repo.aoBin) : undefined });
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
    ...(hasPort(overrides, 'workerTraceDrain') ? { workerTraceDrain: overrides.workerTraceDrain } : config.integrations.neatlogs && !hasPort(overrides, 'trace') ? { workerTraceDrain: new NeatlogsWorkerSpoolAdapter() } : {}),
    ...(hasPort(overrides, 'workerTraceReader') ? { workerTraceReader: overrides.workerTraceReader } : config.integrations.neatlogs && !hasPort(overrides, 'trace') ? { workerTraceReader: new NeatlogsWorkerTraceReader() } : {}),
    intake: overrides.intake ?? new ConfigBacklogIntake(),
    signals: overrides.signals ?? (config.integrations.entire ? new EntireSizingAdapter({ repoPath }) : new RepositorySizingAdapter({ repoPath })),
    worker: overrides.worker ?? runner,
    verifier: overrides.verifier ?? (config.integrations.entire ? new EntireGraphVerifier() : new CommandVerifier()),
    usage: overrides.usage ?? runner,
    sessions: overrides.sessions ?? runner,
    history: overrides.history ?? createPriceHistory(config, configPath),
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

function neatlogsStatus(ports: RealRunPorts, traceState?: RunState['integrations']['neatlogs']): RunState['integrations']['neatlogs'] {
  const workerTraceStatus = ports.workerTraceDrain?.status?.();
  const traces = traceState ?? (workerTraceStatus?.status === 'missing' ? workerTraceStatus : traceStatus(ports.trace));
  const history = ports.history.status?.();
  if (!history) return traces;
  const priority: Record<IntegrationState['status'], number> = { off: 0, ok: 1, missing: 2, error: 3 };
  const status = priority[history.status] > priority[traces.status] ? history.status : traces.status;
  const detail = [traces.detail, history.detail].filter((value): value is string => Boolean(value));
  return { status, detail: detail.length > 0 ? [...new Set(detail)].join('; ') : null };
}

function lastTraceId(trace: TracePort | undefined, runId?: string, taskId?: string, attempt?: number): string | null {
  const withTraceId = trace as (TracePort & { lastTraceId?: (runId?: string, taskId?: string, attempt?: number) => string | null }) | undefined;
  return withTraceId?.lastTraceId?.(runId, taskId, attempt) ?? null;
}

function portStatus(port: unknown, fallback: RunState['integrations']['entire']): RunState['integrations']['entire'] {
  const withStatus = port as { status?: () => RunState['integrations']['entire'] };
  return withStatus.status?.() ?? fallback;
}

function integrationStates(config: TallyConfig, ports: RealRunPorts, options: { dryRun: boolean; budgetSource: BudgetSource; cfoaiReadFailure: string | null }): RunState['integrations'] {
  const cfoaiStatus = options.cfoaiReadFailure
    ? { status: 'missing' as const, detail: `cfo.ai budget read failed: ${options.cfoaiReadFailure}; using the fallback budget in tally.yaml${options.dryRun ? '; simulated workers only; spend not written' : ''}` }
    : ports.cfoai?.status() ?? { status: 'missing' as const, detail: CFOAI_FIX_COMMAND };
  const graph = portStatus(ports.signals, { status: 'missing', detail: 'Entire sizing adapter is not configured. Falling back to code search. Fix: run `entire enable` in this repository.' });
  const recall = ports.recall?.status?.();
  return {
    neatlogs: config.integrations.neatlogs ? neatlogsStatus(ports) : { status: 'off', detail: null },
    entire: config.integrations.entire
      ? recall ? { status: graph.status === 'ok' && recall.status === 'ok' ? 'ok' : 'missing',
          detail: `Graph sizing: ${graph.status}${graph.detail ? ` (${graph.detail})` : ''}; ${recall.detail ?? `checkpoint recall: ${recall.status}`}` } : graph
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

function promptFor(task: BacklogTask, config: TallyConfig, tier: Tier, handoffSummary: string | null, runId: string, attempt: number, publish = true): string {
  const direct = config.runner === 'direct';
  const directCodex = direct && tier.harness === 'codex';
  const setup = config.test.setupCommand
    ? [
        `The environment has already been set up before you started. Do not run setup (${config.test.setupCommand}), install dependencies, or use the network.`,
      ]
    : ['Do not install dependencies or use the network unless the task explicitly requires it.'];
  const publishInstruction = !publish && !direct
    ? 'Commit your changes locally on your current branch. This is a verification-only experiment: do not push or open a PR; Tally will not publish this branch.'
    : directCodex
    ? 'Leave your finished changes uncommitted in the working tree; Tally stages and commits them. Do not run git add, git commit or any command that writes git metadata: your sandbox cannot write it. Do not push or open a pull request; Tally verifies and publishes your changes.'
    : direct
    ? 'You do not need to commit; Tally commits your work. Do not push or open a pull request; Tally verifies and publishes your changes.'
    : config.repo.workerPublishesPr
    ? 'Commit your changes on your current branch, push that branch, open a pull request against the default branch, and do not merge it.'
    : 'Commit your changes on your current branch, but do not push and do not open a pull request; Tally will publish the verified branch.';
  return [
    `${workerCorrelationPrefix(runId, task.taskId, attempt)} ${task.title}`,
    `Neatlogs correlation: runId=${runId} taskId=${task.taskId} attempt=${attempt}.`,
    '',
    config.runner === 'direct' ? 'You are already inside your own git worktree for the target repo. Work only in the current working directory.' : 'You are already inside your own AO git worktree for the target repo. Work only in the current working directory.',
    direct
      ? 'Never read or write any other checkout or path outside this worktree. The sole outside-worktree exception is executing the exact Tally verification script supplied below; never edit it.'
      : 'Never read or write any other checkout or path outside this worktree; this worktree is the authoritative target repo.',
    publishInstruction,
    ...(!direct ? ['Do not run ao commands. Tally handles session reporting and lifecycle; report your result in your final response only.'] : []),
    'Change only what this task needs. Do not add or edit CI, deployment, or tooling config unless the task explicitly asks for it. If a check outside your task fails, report it; do not fix it.',
    ...(direct
      ? ['Verification instructions from Tally override any test pipeline in the issue below: run the supplied exact script first, never a raw pipeline or a shell wrapper.'] : []),
    '',
    task.body || '(No issue body was provided.)',
    '',
    `Target repo: ${repoName(config)}`,
    ...setup,
    direct
      ? 'Run the exact Tally verification script path supplied below before claiming success. Do not run the raw test command.'
      : `Run this verification command before claiming success: ${config.test.command}`,
    `You are running on tier ${tier.name} (${tier.harness}/${tier.model}).`,
    handoffSummary ? `\nHandoff from the previous attempt:\n${handoffSummary}` : '',
    handoffSummary ? `Preserve all inherited commits, including Tally work-in-progress commits. ${direct ? 'Leave your changes for Tally to commit;' : 'Add a new commit for your changes;'} do not amend, squash, reset, or rebase the inherited history.` : '',
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

function shouldFallbackModelAccess(row: Pick<LedgerRow, 'result' | 'resultReason' | 'tier' | 'attempt'>, config: TallyConfig): boolean {
  return Boolean(
    config.modelAccessFallbackTier
      && row.result === 'error'
      && row.attempt < 2
      && row.resultReason?.startsWith(`Model configuration error for tier "${row.tier}"`),
  );
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

async function runAttemptWithRetry(input: Parameters<typeof runSingleAttempt>[0]): Promise<LedgerRow> {
  let row: LedgerRow;
  try {
    row = await runSingleAttempt(input);
  } catch (error) {
    const modelError = modelAccessConfigurationError(error, input.tier);
    if (modelError) {
      if (input.config.modelAccessFallbackTier) return modelAccessFailureRow(input, modelError);
      throw new ConfigError(input.configPath, [modelError]);
    }
    throw error;
  }
  if (row.result === 'error' && row.resultReason === 'worker never started' && !(row.tokens?.total) && !input.dryRun) {
    await input.onStartupError?.(row);
    try {
      return await runSingleAttempt({ ...input, retrySuffix: ':startup-retry', continueBranch: row.branch, continueSessionId: row.sessionId });
    } catch (error) {
      const modelError = modelAccessConfigurationError(error, input.tier);
      if (modelError) {
        if (input.config.modelAccessFallbackTier) return modelAccessFailureRow({ ...input, retrySuffix: ':startup-retry' }, modelError);
        throw new ConfigError(input.configPath, [modelError]);
      }
      throw error;
    }
  }
  return row;
}

function modelAccessFailureRow(input: Parameters<typeof runSingleAttempt>[0], reason: string): LedgerRow {
  const timestamp = input.now().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    attemptId: attemptId(input.runId, input.task.taskId, input.attempt) + (input.retrySuffix ?? ''),
    runId: input.runId,
    taskId: input.task.taskId,
    taskTitle: input.task.title,
    attempt: input.attempt,
    size: input.task.size,
    tier: input.tier.name,
    model: input.tier.model,
    harness: input.tier.harness,
    sessionId: null,
    entireSessionId: null,
    branch: null,
    baseCommit: input.requiredBaseCommit ?? input.baseCommit ?? null,
    tokens: zeroTokens(),
    estimatedCostNanos: 0,
    costSource: input.dryRun ? 'simulated' : 'list-price',
    price: { ...input.tier.price },
    priceNote: tierPriceNote(input.tier),
    ceilingNanos: input.ceilingNanos ?? 0,
    result: 'error',
    resultReason: reason,
    scopeWarnings: [],
    escalatedFrom: input.escalatedFrom,
    handoff: input.handoff,
    handoffText: input.handoffSummary,
    prUrl: null,
    traceId: input.traceId,
    traceUrl: null,
    workerTraceId: null,
    workerTraceUrl: null,
    checkpointId: null,
    checkpointUrl: null,
    decision: input.decision,
    startedAt: timestamp,
    endedAt: timestamp,
  };
}

async function runSingleAttempt(input: {
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
  continueSessionId?: string | null;
  onChangedFiles?: (files: string[]) => void;
  onStartupError?: (row: LedgerRow) => Promise<void>;
  onProgress?: (costNanos: number) => void;
  retrySuffix?: string;
  onEvent?: RunOptions['onEvent'];
  stopRequested?: RunOptions['stopRequested'];
  publish?: boolean;
}): Promise<LedgerRow> {
  let startedAt = input.now().toISOString();
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
    prompt: promptFor(input.task, input.config, input.tier, input.handoffSummary, input.runId, input.attempt, input.publish),
    aoProject: input.config.repo.aoProject,
    continueBranch: input.continueBranch,
    continueSessionId: input.continueSessionId,
  });
  if (started.setupDurationMs !== undefined) startedAt = input.now().toISOString();
  let stopped = false;
  input.onEvent?.({ type: 'worker', taskId: input.task.taskId, attempt: input.attempt, sessionId: started.sessionId, tier: input.tier.name });
  let ceilingStopStarted = false;
  input.onProgress?.(0);
  const reportUsage = (value: LiveUsage | null) => {
    if (value) input.onProgress?.(checkCeiling(value, { sessionId: started.sessionId, tier: input.tier, ceilingNanos: null }).costNanos);
    else input.onProgress?.(0);
    return value;
  };
  const sourceUsage = input.ports.usage as FinalUsagePort;
  const usage: FinalUsagePort = {
    usageFor: async (id) => reportUsage(await sourceUsage.usageFor(id)),
    settledUsageFor: async (id) => reportUsage(await (sourceUsage.settledUsageFor?.(id) ?? sourceUsage.usageFor(id))),
  };
  const watcher = new CeilingWatcher({ usage, sessions: {
    stop: async (sessionId, reason) => {
      ceilingStopStarted = true;
      await input.ports.sessions.stop(sessionId, reason);
    },
  }, trace: input.ports.trace });
  const interruption = setInterval(() => {
    const reason = input.stopRequested?.();
    if (reason) void input.ports.sessions.stop(started.sessionId, reason).catch(() => {});
  }, input.dryRun ? 1 : 250);
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
  let tallyCommit: string | null = null;
  let entireSessionId: string | null = null;
  let workerTraceId: string | null = null;
  let workerTraceDetail: string | null = null;
  let resolvedCheckoutPath: string | null = null;

  try {
  let first = await Promise.race([watched.then((verdict) => ({ kind: 'watch' as const, verdict })), worker.then((result) => ({ kind: 'worker' as const, result }))]);
  // Killing can resolve the worker poll before the watcher records its stop verdict.
  if (first.kind === 'worker' && ceilingStopStarted) first = { kind: 'watch', verdict: await watched };
  if (first.kind === 'watch' && first.verdict.action === 'stop') {
    stopped = first.verdict.stopped;
    abort.abort();
    if (!input.dryRun) workerResult = await worker;
    result = 'stopped';
    resultReason = first.verdict.reason;
    tokens = first.verdict.tokens;
    estimatedCostNanos = first.verdict.costNanos;
    costSource = input.dryRun ? 'simulated' : first.verdict.costSource;
    if (!input.dryRun) {
      const branch = workerResult?.branch ?? started.branch;
      const wip = branch ? await input.ports.worktrees.commitWorkInProgress?.(repoPath, branch) : null;
      resultReason += wip ? `; work in progress committed as ${wip}` : '; stopped before any edits; next attempt starts clean';
    }
  } else {
    abort.abort();
    workerResult = first.kind === 'worker' ? first.result : await worker;
    const completionPort = usage;
    const completionUsage = input.dryRun ? null : await (completionPort.settledUsageFor?.(started.sessionId) ?? completionPort.usageFor(started.sessionId));
    if (input.stopRequested?.()) {
      result = workerResult.status === 'experiment_stop' || input.stopRequested()!.startsWith('stopped:') ? 'stopped' : 'error';
      resultReason = input.stopRequested()!;
    } else if (!input.dryRun && (workerResult.status === 'never_started' || ((workerResult.status === 'idle' || workerResult.status === 'terminated') && !(completionUsage?.tokens.total)))) {
      result = 'error';
      const startupReason = workerResult.permissionWarnings?.length
        ? `permission failure: worker produced no commit after refused commands: ${workerResult.permissionWarnings.join('; ')}`
        : workerResult.resultReason ?? 'worker never started';
      resultReason = modelAccessConfigurationError(startupReason, input.tier)
        ?? (workerResult.status === 'never_started' && startupReason !== 'worker never started' ? 'worker never started' : startupReason);
    } else if (workerResult.status === 'experiment_stop') {
      result = 'stopped';
      resultReason = workerResult.resultReason ?? 'stopped: experiment cap reached';
    } else if ((workerResult.status === 'needs_input' && input.config.runner === 'direct') || workerResult.status === 'timeout' || workerResult.status === 'error') {
      result = 'error';
      const reason = workerResult.resultReason ?? (workerResult.status === 'timeout' ? 'worker exceeded wall-clock limit' : 'worker asked for input');
      resultReason = modelAccessConfigurationError(reason, input.tier) ?? reason;
    } else {
      let checkoutPath = workerResult.checkoutPath ?? started.checkoutPath;
      const branch = workerResult.branch ?? started.branch;
      if (!input.dryRun && !checkoutPath && branch) {
        checkoutPath = await input.ports.worktrees.checkoutPathFor(resolve(dirname(input.configPath), input.config.repo.path), branch);
      }
      resolvedCheckoutPath = checkoutPath;
      if (!input.dryRun && (workerResult.status === 'idle' || workerResult.status === 'needs_input') && checkoutPath && branch) {
        tallyCommit = await input.ports.worker.commitChanges?.(started.sessionId) ?? null;
      }
      if (!input.dryRun && (!checkoutPath || !branch)) {
        result = 'error';
        resultReason = 'could not locate worker checkout';
      } else if (!input.dryRun && (await input.ports.publisher.commitsAhead({ checkoutPath: checkoutPath!, branch: branch!, config: input.config })) <= 0) {
        result = input.config.runner !== 'direct' || workerResult.permissionWarnings?.length ? 'error' : 'failed';
        resultReason = workerResult.status === 'needs_input'
          ? 'worker stuck: asked for input with no work on its branch'
          : input.config.runner !== 'direct'
          ? 'worker stuck: no work on its branch'
          : workerResult.permissionWarnings?.length
          ? `permission failure: worker produced no commit after refused commands: ${workerResult.permissionWarnings.join('; ')}`
          : 'no changes made';
      } else {
        const verification = await input.ports.verifier.verify({
          checkoutPath,
          branch,
          repoPath: resolve(dirname(input.configPath), input.config.repo.path),
          config: input.config,
        });
        result = verification.passed ? 'passed' : 'failed';
        resultReason = verification.reason;
        if (verification.passed && workerResult.status === 'needs_input' && !resultReason) resultReason = 'worker asked for input; Tally independently verified its work';
        if (verification.passed && input.stopRequested?.()) {
          result = 'error';
          resultReason = input.stopRequested()!;
        } else if (verification.passed && !input.dryRun) {
          scopeWarnings = outOfScopeFiles(input.task, await input.ports.publisher.changedFiles({ checkoutPath: checkoutPath!, branch: branch!, config: input.config, baseCommit: attemptBase }));
          if (scopeWarnings.length && input.config.repo.blockOutOfScopeChanges) {
            result = 'error';
            resultReason = `out-of-scope changes: ${scopeWarnings.join(', ')}`;
          } else if (input.publish === false) {
            resultReason = resultReason ?? 'verified locally; publishing disabled for experiment';
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
    if (!entireSessionId) {
      entireSessionId = await input.ports.checkpoints.sessionIdFor?.({ sessionId: started.sessionId, branch, checkoutPath }).catch(() => null) ?? null;
    }
  }
  } catch (error) {
    result = 'error';
    resultReason = error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(interruption);
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
  const usagePort = usage;
  const finalUsage = usagePort.settledUsageFor ? await usagePort.settledUsageFor(started.sessionId) : await usagePort.usageFor(started.sessionId);
  if (finalUsage) {
    const finalCheck = checkCeiling(finalUsage, { sessionId: started.sessionId, tier: input.tier, ceilingNanos: input.ceilingNanos });
    tokens = finalCheck.tokens;
    estimatedCostNanos = finalCheck.costNanos;
    costSource = input.dryRun ? 'simulated' : finalCheck.costSource;
  }
  if (!input.dryRun && input.config.integrations.neatlogs) {
    if (input.tier.harness === 'codex') {
      const branch = workerResult?.branch ?? started.branch;
      const checkoutPath = resolvedCheckoutPath ?? workerResult?.checkoutPath ?? started.checkoutPath ?? (branch
        ? await input.ports.worktrees.checkoutPathFor(resolve(dirname(input.configPath), input.config.repo.path), branch).catch(() => null) : null);
      await input.ports.workerTraceDrain?.drainWorker({ checkoutPath, entireSessionId }).catch(() => {});
      const drainStatus = input.ports.workerTraceDrain?.status?.();
      if (drainStatus?.status !== 'ok' && drainStatus?.detail && !drainStatus.detail.startsWith('No queued worker trace found')) {
        workerTraceDetail = drainStatus.detail;
      }
    }
    workerTraceId = await input.ports.workerTraceReader?.verifyFor({
      runId: input.runId, taskId: input.task.taskId, attempt: input.attempt,
      nativeSessionId: input.config.runner === 'direct' ? started.sessionId : entireSessionId,
    }).catch(() => null) ?? null;
    if (!workerTraceId) {
      const readStatus = input.ports.workerTraceReader?.status?.();
      workerTraceDetail = [workerTraceDetail, readStatus?.detail].filter((detail): detail is string => Boolean(detail)).join('; ') || null;
    }
  }

  if (!input.dryRun && input.onChangedFiles) {
    const branch = workerResult?.branch ?? started.branch;
    if (branch) {
      // AO removes the worker worktree on close; its branch survives in the shared repository.
      const files = await input.ports.publisher.changedFiles({ checkoutPath: repoPath, branch, config: input.config, baseCommit: attemptBase }).catch(() => null);
      if (files !== null) input.onChangedFiles(files);
    }
  }
  if (input.dryRun && input.onChangedFiles && input.ports.worker.changedFilesFor) {
    const files = await input.ports.worker.changedFilesFor(started.sessionId);
    if (files !== null) input.onChangedFiles(files);
  }
  if (!input.dryRun && result === 'passed') {
    try { await input.ports.worker.release?.(started.sessionId); }
    catch (error) { resultReason = `${resultReason ?? 'verified and published'}; checkout cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
  }

  if (workerResult?.permissionWarnings?.length && (result === 'passed' || result === 'failed')) {
    resultReason = `${resultReason ? `${resultReason}; ` : ''}warning: ${workerResult.permissionWarnings.join('; ')}`;
  }
  if (tallyCommit) resultReason = `${resultReason ? `${resultReason}; ` : ''}Tally committed task changes as ${tallyCommit}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    attemptId: attemptId(input.runId, input.task.taskId, input.attempt) + (input.retrySuffix ?? ''),
    runId: input.runId,
    taskId: input.task.taskId,
    taskTitle: input.task.title,
    attempt: input.attempt,
    size: input.task.size,
    tier: input.tier.name,
    model: input.tier.model,
    harness: input.tier.harness,
    sessionId: started.sessionId,
    ...(started.setupDurationMs !== undefined ? { setupDurationMs: started.setupDurationMs } : {}),
    entireSessionId,
    branch: input.dryRun ? null : (workerResult?.branch ?? started.branch),
    baseCommit: attemptBase,
    tokens: tokens ?? zeroTokens(),
    estimatedCostNanos,
    costSource,
    price: { ...input.tier.price },
    priceNote: `${input.dryRun ? 'Simulated usage; no spend. ' : ''}${tierPriceNote(input.tier)}${input.config.runner === 'direct' && input.tier.harness === 'claude-code' ? ' Cache writes: 1.25x (5m) / 2x (1h) input rate, https://platform.claude.com/docs/en/build-with-claude/prompt-caching . Live meter updates at API message boundaries, not every generated token.' : ''}`,
    ceilingNanos: input.ceilingNanos ?? 0,
    result,
    resultReason,
    scopeWarnings,
    ...(workerResult?.permissionWarnings?.length ? { permissionWarnings: workerResult.permissionWarnings } : {}),
    ...(tallyCommit ? { tallyCommit } : {}),
    escalatedFrom: input.escalatedFrom,
    handoff: input.handoff,
    handoffText: input.handoffSummary,
    prUrl: input.dryRun ? null : prUrl,
    traceId: input.traceId,
    traceUrl: null,
    workerTraceId,
    workerTraceUrl: null,
    ...(workerTraceDetail ? { workerTraceDetail } : {}),
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
    priceNote: 'Unverified: Entire-generated summary cost reported by the handoff adapter; no model list price supplied.',
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
  const requestedConcurrency = options.parallel ?? config.parallelWorkers ?? 1;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) throw new Error('parallel worker count must be a positive integer');
  if (config.runner === 'direct' && options.parallel !== undefined && options.parallel > 1) throw new Error('parallel workers require runner ao; direct remains sequential');
  const concurrency = config.runner === 'direct' || options.baseline ? 1 : requestedConcurrency;
  let safetyStop: string | null = null;
  const stopRequested = () => safetyStop ?? options.stopRequested?.() ?? null;
  if (options.baseline && (options.parallel ?? 1) > 1) throw new Error('parallel AO workers require per-attempt ceilings; baseline remains sequential');
  if (concurrency > 1 && config.entire?.generatedSummaries) throw new Error('parallel workers require metadata-only handoffs; generated summary cost cannot be reserved');
  const ports = resolvePorts(config, options.configPath, options.ports, options.requiredBaseCommit);
  const now = options.now ?? (() => new Date());
  const started = now();
  const runId = options.runId ?? runIdFrom(started);
  const mode: RunMode = options.baseline ? 'baseline' : 'tally';
  const outputDir = options.outputDir ? resolve(options.outputDir) : defaultOutputDir(runId);
  const ledgerPath = resolve(outputDir, 'ledger.json');
  const ledger = loadLedger(ledgerPath);
  let budgetLimitNanos = usdToNanos(options.budgetUsd ?? config.budget.usd);
  let budgetSource: BudgetSource = 'config';
  let monthlyLimitNanos = usdToNanos(config.budget.usd);
  let monthlySpentNanos = 0;
  let cfoaiWriteFailure: string | null = null;
  let cfoaiReadFailure: string | null = null;
  let committedBeforeRunNanos = 0;
  if ((config.integrations.cfoai || config.budget.source === 'cfoai') && ports.cfoai) {
    try {
      const [limit, currentSpend] = await Promise.all([ports.cfoai.budgetLimitNanos(), ports.cfoai.currentSpendNanos?.() ?? Promise.resolve(0)]);
      monthlyLimitNanos = limit;
      monthlySpentNanos = currentSpend;
      budgetSource = 'cfoai';
      if (options.budgetUsd === undefined && config.budget.source === 'cfoai') {
        budgetLimitNanos = limit;
        committedBeforeRunNanos = Math.max(0, currentSpend - ledgerSpend(ledger));
      }
    } catch (error) {
      cfoaiReadFailure = error instanceof Error ? error.message : String(error);
      if (concurrency > 1 && !options.dryRun) throw new RunError([`parallel AO run cannot reserve the monthly budget: cfo.ai read failed: ${error instanceof Error ? error.message : String(error)}; no workers were started. Restore cfo.ai access or run sequentially with --parallel 1.`]);
      budgetSource = 'config';
    }
  }
  const ledgerBudget = new LedgerBudget(budgetLimitNanos, ledger, committedBeforeRunNanos);
  const monthlyCommittedBeforeRun = Math.max(0, monthlySpentNanos - ledgerSpend(ledger));
  const reservations = new Reservations(() => Math.min(
    budgetLimitNanos - committedBeforeRunNanos - ledgerSpend(ledger),
    monthlyLimitNanos - monthlyCommittedBeforeRun - ledgerSpend(ledger),
  ));
  const decisions = new SerialQueue();
  const accounting = new SerialQueue();
  const recordSpend = (row: LedgerRow) => accounting.run(async () => {
    if (options.dryRun) return;
    const cumulative = ledgerSpend(ledger);
    const attempts = ledger.map((attempt) => ({ tier: attempt.tier, costNanos: attempt.estimatedCostNanos }));
    appendCfoaiFallback(outputDir, row, cumulative);
    if (!config.integrations.cfoai || !ports.cfoai) return;
    try {
      await ports.cfoai.writeCumulativeActualSpend(cumulative);
      await ports.cfoai.writeSpendDetail?.({
        attempts,
        cumulativeRunSpendNanos: cumulative,
      });
      cfoaiWriteFailure = null;
    } catch (error) {
      cfoaiWriteFailure = `write failed: ${error instanceof Error ? error.message : String(error)}; actual spend retained in cfoai-spend-fallback.csv`;
      // CSV fallback has already preserved the attempted spend for a later sync.
    }
  });
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
  const liveCosts = new Map<string, number>();
  const progressFor = (index: number, attempt: number, tier: Tier) => (cost: number) => {
    const state = taskStates[index]!;
    liveCosts.set(state.taskId, Math.max(liveCosts.get(state.taskId) ?? 0, cost));
    state.status = 'running';
    state.statusReason = null;
    state.attempts = attempt;
    state.tier = tier.name;
    state.model = tier.model;
    state.escalated = attempt > 1;
    state.spentNanos = ledger.filter((row) => row.taskId === state.taskId).reduce((sum, row) => sum + row.estimatedCostNanos, 0) + liveCosts.get(state.taskId)!;
    if (concurrency > 1 && ledgerSpend(ledger) + [...liveCosts.values()].reduce((sum, cost) => sum + cost, 0)
      >= Math.min(budgetLimitNanos - committedBeforeRunNanos, monthlyLimitNanos - monthlyCommittedBeforeRun)) {
      safetyStop = 'stopped: shared run cap or monthly budget reached';
    }
    writeCurrent('running', null);
    options.onEvent?.({ type: 'spend', taskId: state.taskId, attempt, costNanos: liveCosts.get(state.taskId)! });
  };
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
      backlog: { ...config.backlog },
      baseCommit,
      startedAt: started.toISOString(),
      updatedAt,
      endedAt,
      budget: {
        source: budgetSource,
        monthly: { source: budgetSource, limitNanos: monthlyLimitNanos, spentBeforeRunNanos: monthlySpentNanos },
        limitSource: options.budgetUsd === undefined ? config.budget.source === 'cfoai' ? budgetSource : 'config' : 'cli',
        systemOfRecord: config.integrations.cfoai && ports.cfoai ? 'cfoai' : 'ledger',
        ...((config.budget.source === 'cfoai' || config.integrations.cfoai) && config.budget.cfoai
          ? { cfoai: {
            ...(config.budget.cfoai.pageUrl ? { pageUrl: config.budget.cfoai.pageUrl } : {}),
            ...(config.budget.cfoai.tableUrl ? { tableUrl: config.budget.cfoai.tableUrl } : {}),
          } }
          : {}),
        limitNanos: budgetLimitNanos,
        spentNanos: ledgerSpend(ledger) + [...liveCosts.values()].reduce((sum, cost) => sum + cost, 0),
      },
      tasks: taskStates,
      integrations: integrationStates(config, ports, { dryRun: options.dryRun, budgetSource, cfoaiReadFailure }),
    };
    if (cfoaiWriteFailure) runState.integrations.cfoai = { status: 'error', detail: cfoaiWriteFailure };
    const workerRows = ledger.filter(row => row.sessionId && (row.harness === 'codex' || row.harness === 'claude-code'));
    if (!options.dryRun && config.integrations.neatlogs && workerRows.length > 0 && workerRows.every(row => row.workerTraceId)
      && ports.workerTraceDrain?.status?.().detail?.startsWith('No queued worker trace found')) {
      runState.integrations.neatlogs = neatlogsStatus(ports, traceStatus(ports.trace));
    }
    if (!options.dryRun && config.integrations.neatlogs && workerRows.some(row => !row.workerTraceId)) {
      const workerDetails = workerRows.filter(row => !row.workerTraceId).map(row => row.workerTraceDetail).filter((detail): detail is string => Boolean(detail));
      const details = [
        runState.integrations.neatlogs.detail,
        ...workerDetails,
        ...(workerDetails.length ? [] : ['Decision traces sent; worker trace delivery is unverified or pending. Run `tally traces drain --run ' + runId + '` to retry.']),
      ].filter((value): value is string => Boolean(value));
      runState.integrations.neatlogs = {
        status: runState.integrations.neatlogs.status === 'error' ? 'error' : 'missing',
        detail: [...new Set(details)].join('; '),
      };
    }
    assertValid(runState, ledger);
    writeRunFiles(outputDir, runState, ledger, options.latestRunDir);
    return runState;
  };
  const initialRun = writeCurrent('running', null);
  options.onEvent?.({ type: 'budget', budget: initialRun.budget });
  const finishAttempt = (row: LedgerRow) => {
    ledger.push(row);
    if (concurrency > 1) reservations.settle(row.taskId, row.estimatedCostNanos);
    liveCosts.delete(row.taskId);
    const index = taskStates.findIndex((state) => state.taskId === row.taskId);
    if (index >= 0) taskStates[index] = stateFromRows(taskStates[index]!, ledger.filter((item) => item.taskId === row.taskId));
    writeCurrent('running', null);
    options.onEvent?.({ type: 'result', row });
  };
  const onStartupError = async (row: LedgerRow) => {
    finishAttempt(row);
    await recordSpend(row);
    writeCurrent('running', null);
    if (row.ceilingNanos !== null && row.ceilingNanos > await ledgerBudget.remainingNanos()) throw new Error('worker never started; no budget for startup retry');
  };

  const processTask = async (task: BacklogTask, index: number) => {
    const taskBudget: BudgetPort = concurrency === 1 ? ledgerBudget : { remainingNanos: async () => reservations.remaining(task.taskId) };
    // Each task sees its own held funds, but never another running task's reservation.
    const budget = taskBudget;
    const routingBudget: BudgetPort = concurrency === 1 ? budget : {
      remainingNanos: async () => Math.min(budgetLimitNanos - committedBeforeRunNanos, monthlyLimitNanos - monthlyCommittedBeforeRun) - ledgerSpend(ledger),
    };
    const runAttempt = async (input: Parameters<typeof runAttemptWithRetry>[0]) => {
      if (concurrency > 1) {
        for (;;) {
          const admission = await decisions.run(async () => {
            const cost = input.ceilingNanos ?? Infinity;
            const next = input.attempt === 1 ? config.tiers[config.tiers.findIndex(t => t.name === input.tier.name) + 1] : undefined;
            const fallback = input.attempt === 1 && config.modelAccessFallbackTier
              ? config.tiers.find(tier => tier.name === config.modelAccessFallbackTier)
              : undefined;
            const retryCeiling = [next, fallback]
              .filter((tier): tier is Tier => Boolean(tier))
              .reduce((maximum, tier) => Math.max(maximum, ceilingNanos(config, input.task.size, tier)), 0);
            const amount = cost + retryCeiling;
            const fits = reservations.reserve(task.taskId, amount);
            return { fits, wait: fits ? null : reservations.waiting(task.taskId) };
          });
          if (admission.fits) break;
          if (!admission.wait) throw new Error('not started: reservation does not fit the run cap and monthly budget');
          await admission.wait;
          if (stopRequested()) throw new Error(stopRequested()!);
        }
      }
      if (stopRequested()) throw new Error(stopRequested()!);
      return runAttemptWithRetry({ ...input, stopRequested, publish: options.publish });
    };
    try {
      const stopReason = stopRequested();
      if (stopReason) {
        taskStates[index]!.status = 'skipped';
        taskStates[index]!.statusReason = stopReason;
        return;
      }
      const existingRows = ledger.filter((row) => row.taskId === task.taskId);
      if (isTaskDone(existingRows)) {
        taskStates[index] = stateFromRows(taskStates[index]!, existingRows);
        writeCurrent('running', null);
        return;
      }
      const interrupted = existingRows[existingRows.length - 1];
      if (interrupted && interrupted.result !== 'passed' && interrupted.attempt === 1) {
        task.size = interrupted.size;
        let latest = interrupted;
        if (interrupted.result !== 'error' || shouldFallbackModelAccess(interrupted, config)) {
          const escalation = await decisions.run(() => decideEscalation({
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
          }));
          const escalationTraceId = lastTraceId(ports.trace, runId, task.taskId, 2);
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
              continueBranch: escalation.handoffBranch ?? interrupted.branch,
              continueSessionId: interrupted.sessionId,
              onChangedFiles: changedFor(index),
              onStartupError,
              onProgress: progressFor(index, 2, escalation.tier),
              onEvent: options.onEvent,
            });
            finishAttempt(latest);
            await recordHistory({ ports, row: latest, dryRun: options.dryRun });
            await recordSpend(latest);
          } else {
            interrupted.resultReason = escalation.statusReason;
          }
        }
        taskStates[index] = stateFromRows(taskStates[index]!, ledger.filter((row) => row.taskId === task.taskId));
        writeCurrent('running', null);
        return;
      }
      const taskInput = { taskId: task.taskId, title: task.title, body: task.body };
      const sized = await sizeTask(taskInput, { signals: ports.signals, trace: ports.trace });
      let estimate = sized;
      if (ports.recall) {
        try {
          estimate = applyCheckpointRecall(sized, await ports.recall.recallFor(taskInput));
        } catch (error) {
          estimate = { ...sized, summary: `${sized.summary}; checkpoint recall unavailable: ${error instanceof Error ? error.message : 'search failed'}` };
        }
        const recallStatus = ports.recall.status?.();
        if (recallStatus?.status === 'missing') estimate = { ...estimate, summary: `${estimate.summary}; ${recallStatus.detail}` };
      }
      task.size = estimate.size;
      const state = taskStates[index]!;
      state.size = estimate.size;
      state.impact ??= structuredClone(estimate.signals?.impact ?? {
        source: estimate.signals?.source ?? 'none', query: `${task.title}\n${task.body}`.trim(), nodes: [], edges: [],
        totals: { filesTouched: estimate.signals?.filesTouched ?? 0, dependents: estimate.signals?.dependents ?? 0, testsPresent: estimate.signals?.testsPresent ?? false, nodes: 0, edges: 0 }, truncated: false,
      });
      writeCurrent('running', null);
      const route = await decisions.run(async () => options.baseline
        ? await routeBaseline({
            task: taskInput,
            estimate,
            config,
            ports: { history: ports.history, budget: routingBudget, trace: ports.trace },
            traceAttributes: { sessionId: runId, taskId: task.taskId, attempt: 1 },
          })
        : await routeTask({
            task: taskInput,
            estimate,
            config,
            ports: { history: ports.history, budget: routingBudget, trace: ports.trace },
            traceAttributes: { sessionId: runId, taskId: task.taskId, attempt: 1 },
          }));
      const routeTraceId = lastTraceId(ports.trace, runId, task.taskId, 1);
      options.onEvent?.({ type: 'route', taskId: task.taskId, size: estimate.size, confidence: estimate.confidence,
        tier: route.action === 'start' ? route.tier.name : null,
        harness: route.action === 'start' ? route.tier.harness : null,
        model: route.action === 'start' ? route.tier.model : null,
        ceilingNanos: route.action === 'start' ? task.firstAttemptCeilingUsd === undefined || options.baseline ? route.ceilingNanos : Math.min(route.ceilingNanos ?? Infinity, usdToNanos(task.firstAttemptCeilingUsd)) : null,
        decision: route.reason });
      if (route.action === 'skip') {
        state.status = 'skipped';
        state.statusReason = route.statusReason;
        writeCurrent('running', null);
        return;
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
        onStartupError,
        onProgress: progressFor(index, 1, route.tier),
        onEvent: options.onEvent,
      });
      finishAttempt(first);
      if (first.result === 'stopped' && stopRequested()) first.resultReason = stopRequested()!;
      await recordHistory({ ports, row: first, dryRun: options.dryRun });
      await recordSpend(first);
      let latest = first;
      if (first.result !== 'passed' && (first.result !== 'error' || shouldFallbackModelAccess(first, config)) && !stopRequested()) {
        const escalation = await decisions.run(() => decideEscalation({
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
        }));
        const escalationTraceId = lastTraceId(ports.trace, runId, task.taskId, 2);
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
            continueBranch: escalation.handoffBranch ?? first.branch,
            continueSessionId: first.sessionId,
            onChangedFiles: changedFor(index),
            onStartupError,
            onProgress: progressFor(index, 2, escalation.tier),
            onEvent: options.onEvent,
          });
          finishAttempt(latest);
          await recordHistory({ ports, row: latest, dryRun: options.dryRun });
          await recordSpend(latest);
        } else {
          latest.resultReason = latest.result === 'error' && latest.resultReason ? latest.resultReason : escalation.statusReason;
        }
      }
      const rows = ledger.filter((row) => row.taskId === task.taskId);
      taskStates[index] = stateFromRows(taskStates[index]!, rows);
      writeCurrent('running', null);
    } catch (error) {
      if (concurrency === 1) throw error;
      const state = taskStates[index]!;
      state.status = (stopRequested() && !ledger.some(row => row.taskId === task.taskId)) || (error instanceof Error && error.message.startsWith('not started:')) ? 'skipped' : 'failed';
      state.statusReason = error instanceof Error ? error.message : String(error);
      liveCosts.delete(task.taskId);
      writeCurrent('running', null);
    } finally {
      if (concurrency > 1) reservations.release(task.taskId);
    }
  };
  await runPool(tasks, concurrency, processTask);

  const endedAt = now().toISOString();
  const runState = writeCurrent(stopRequested() ? 'interrupted' : 'finished', endedAt);
  await (ports.trace as (TracePort & { flush?: () => Promise<void> }) | undefined)?.flush?.();
  const paths = writeRunFiles(outputDir, runState, ledger, options.latestRunDir);
  return { runState, ledger, ...paths };
}
