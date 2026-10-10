import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attemptId, ceilingNanos, SCHEMA_VERSION, usdToNanos, validateLedger, validateRunState } from '../schema/index.js';
import type {
  AttemptResult,
  IntegrationName,
  IntegrationState,
  Ledger,
  LedgerRow,
  RunMode,
  RunState,
  TaskSize,
  TaskState,
  TallyConfig,
  Tier,
  TokenUsage,
} from '../schema/index.js';
import { loadConfig } from './config.js';
import { type BacklogTask, loadFileBacklog } from './backlog.js';
import { runRealTally, type RealRunOptions } from './real.js';

export interface RunOptions {
  configPath: string;
  dryRun: boolean;
  baseline: boolean;
  budgetUsd?: number;
  only?: string;
  outputDir?: string;
  now?: () => Date;
}

export interface RunResult {
  runState: RunState;
  ledger: Ledger;
  outputDir: string;
  runStatePath: string;
  ledgerPath: string;
}

export class RunError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'RunError';
  }
}

const SIZE_INDEX: Record<TaskSize, number> = { small: 0, medium: 1, large: 2 };
const INTEGRATIONS: IntegrationName[] = ['neatlogs', 'entire', 'cfoai', 'github', 'slack'];

function iso(now: () => Date): string {
  return now().toISOString();
}

function runIdFrom(date: Date): string {
  return `run-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')}`;
}

function repoName(config: TallyConfig): string {
  return config.repo.slug ?? config.repo.path;
}

function tierFor(config: TallyConfig, size: TaskSize, mode: RunMode): Tier {
  if (config.tiers.length === 0) throw new RunError(['at least one tier is required']);
  if (mode === 'baseline') return config.tiers[config.tiers.length - 1]!;
  return config.tiers[Math.min(SIZE_INDEX[size], config.tiers.length - 1)]!;
}

function nextTier(config: TallyConfig, tier: Tier): Tier | null {
  const index = config.tiers.findIndex((candidate) => candidate.name === tier.name);
  return index >= 0 && index < config.tiers.length - 1 ? config.tiers[index + 1]! : null;
}

function statusFrom(result: AttemptResult): TaskState['status'] {
  if (result === 'passed') return 'passed';
  return 'failed';
}

function simulatedCost(ceiling: number, result: AttemptResult, attempt: number): number {
  if (result === 'stopped') return ceiling + 10_000_000;
  if (result === 'failed' || result === 'error') return Math.round(ceiling * 0.5);
  const share = attempt > 1 ? 0.37 : 0.35;
  return Math.max(1, Math.round(ceiling * share));
}

function simulatedTokens(size: TaskSize, result: AttemptResult, attempt: number): TokenUsage {
  const scale = { small: 1, medium: 3, large: 7 }[size] * attempt;
  const uncachedInput = 30_000 * scale;
  const cachedInput = 120_000 * scale;
  const output = (result === 'stopped' ? 12_000 : 8_000) * scale;
  return { uncachedInput, cachedInput, output, total: uncachedInput + cachedInput + output };
}

function decision(task: BacklogTask, tier: Tier, mode: RunMode, attempt: number): string {
  if (mode === 'baseline') return `Baseline mode sends ${task.size} task ${task.taskId} straight to the strongest configured tier, ${tier.name}.`;
  if (attempt > 1) return `Escalating ${task.taskId} one tier after the previous simulated attempt did not pass.`;
  return `${task.taskId} is a ${task.size} task, so dry-run routing starts it on the configured ${tier.name} tier.`;
}

function integrationStates(config: TallyConfig): Record<IntegrationName, IntegrationState> {
  return Object.fromEntries(
    INTEGRATIONS.map((name) => {
      if (name === 'github' && config.backlog.source === 'file') {
        return [name, { status: 'off', detail: 'Backlog loaded from file.' }];
      }
      const enabled = name === 'github' ? config.backlog.source === 'github-issues' : config.integrations[name] === true;
      return [name, enabled ? { status: 'missing', detail: 'Adapter not implemented yet.' } : { status: 'off', detail: null }];
    }),
  ) as Record<IntegrationName, IntegrationState>;
}

function initialTaskState(task: BacklogTask): TaskState {
  return {
    taskId: task.taskId,
    title: task.title,
    issueNumber: task.issueNumber,
    issueUrl: task.issueUrl,
    size: task.size,
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

function assertValid(runState: RunState, ledger: Ledger): void {
  const runStateResult = validateRunState(runState);
  const ledgerResult = validateLedger(ledger);
  const errors = [...runStateResult.errors, ...ledgerResult.errors];
  if (errors.length > 0) throw new RunError(errors);
}

export async function runTally(options: RunOptions | RealRunOptions): Promise<RunResult> {
  if (!options.dryRun) return runRealTally(options as RealRunOptions);
  const config = loadConfig(options.configPath);
  const mode: RunMode = options.baseline ? 'baseline' : 'tally';
  const now = options.now ?? (() => new Date());
  const started = now();
  const runId = runIdFrom(started);
  const tasks = loadFileBacklog(config, options.configPath).filter((task) => {
    if (options.only === undefined) return true;
    return task.taskId === options.only || String(task.issueNumber) === options.only;
  });
  if (tasks.length === 0) throw new RunError([options.only ? `no task matched --only ${options.only}` : 'backlog is empty']);

  const budgetLimit = usdToNanos(options.budgetUsd ?? config.budget.usd);
  const ledger: Ledger = [];
  const taskStates = tasks.map(initialTaskState);
  let committedNanos = 0;

  for (const [taskIndex, task] of tasks.entries()) {
    const taskState = taskStates[taskIndex]!;
    let tier = tierFor(config, task.size, mode);
    let previousAttemptId: string | null = null;
    for (let i = 0; i < task.outcomes.length; i += 1) {
      const attempt = i + 1;
      const ceiling = ceilingNanos(config, task.size, tier);
      if (committedNanos + ceiling > budgetLimit) {
        taskState.status = taskState.attempts === 0 ? 'skipped' : 'failed';
        taskState.statusReason = 'not started: no budget';
        break;
      }
      const result = task.outcomes[i]!;
      const startedAt = iso(now);
      const endedAt = iso(now);
      const cost = simulatedCost(ceiling, result, attempt);
      const id = attemptId(runId, task.taskId, attempt);
      const row: LedgerRow = {
        schemaVersion: SCHEMA_VERSION,
        attemptId: id,
        runId,
        taskId: task.taskId,
        taskTitle: task.title,
        attempt,
        size: task.size,
        tier: tier.name,
        model: tier.model,
        harness: tier.harness,
        sessionId: null,
        branch: null,
        tokens: simulatedTokens(task.size, result, attempt),
        estimatedCostNanos: cost,
        costSource: 'simulated',
        ceilingNanos: ceiling,
        result,
        resultReason: result === 'passed' ? null : result === 'stopped' ? 'simulated ceiling crossed' : `simulated ${result}`,
        escalatedFrom: previousAttemptId,
        handoff: previousAttemptId === null ? 'none' : 'entire-handoff',
        prUrl: null,
        traceUrl: null,
        checkpointId: null,
        checkpointUrl: null,
        decision: decision(task, tier, mode, attempt),
        startedAt,
        endedAt,
      };
      ledger.push(row);
      committedNanos += cost;
      taskState.status = statusFrom(result);
      taskState.statusReason = row.resultReason;
      taskState.attempts = attempt;
      taskState.tier = tier.name;
      taskState.model = tier.model;
      taskState.spentNanos += cost;
      taskState.escalated = previousAttemptId !== null;
      if (result === 'passed') break;
      previousAttemptId = id;
      const escalationTier = nextTier(config, tier);
      if (escalationTier === null) break;
      tier = escalationTier;
    }
  }

  const endedAt = iso(now);
  const runState: RunState = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    mode,
    dryRun: true,
    status: 'finished',
    repo: repoName(config),
    baseCommit: null,
    startedAt: started.toISOString(),
    updatedAt: endedAt,
    endedAt,
    budget: { source: config.budget.source, limitNanos: budgetLimit, spentNanos: ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0) },
    tasks: taskStates,
    integrations: integrationStates(config),
  };
  assertValid(runState, ledger);

  const outputDir = resolve(options.outputDir ?? `.tally/runs/${runId}`);
  mkdirSync(outputDir, { recursive: true });
  const runStatePath = resolve(outputDir, 'run.json');
  const ledgerPath = resolve(outputDir, 'ledger.json');
  writeFileSync(runStatePath, `${JSON.stringify(runState, null, 2)}\n`);
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { runState, ledger, outputDir, runStatePath, ledgerPath };
}

export async function runDemo(options: Pick<RunOptions, 'outputDir' | 'now'> = {}): Promise<RunResult> {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tally-demo-'));
  const configPath = join(dir, 'tally.yaml');
  writeFileSync(
    configPath,
    `version: 1
repo: { path: ".", slug: "demo/tally-sample", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: litellm
    model: nova-micro
    price: { inputUsdPerMTok: 0.035, cachedInputUsdPerMTok: 0.00875, outputUsdPerMTok: 0.14 }
    ceilingFraction: 0.2
  - name: middle
    harness: claude-code
    provider: litellm
    model: claude-sonnet-4.6
    price: { inputUsdPerMTok: 3.3, cachedInputUsdPerMTok: 0.33, outputUsdPerMTok: 16.5 }
    ceilingFraction: 0.5
  - name: top
    harness: claude-code
    provider: litellm
    model: claude-opus-4.6
    price: { inputUsdPerMTok: 5.5, cachedInputUsdPerMTok: 0.55, outputUsdPerMTok: 27.5 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 4, large: 10 }
budget: { source: config, usd: 40 }
concurrency: 3
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
  );
  writeFileSync(
    join(dir, 'backlog.yaml'),
    `tasks:
  - id: T1
    title: Add validation for empty player name
    size: small
    outcomes: [passed]
  - id: T2
    title: Persist settings after restart
    size: medium
    outcomes: [stopped, passed]
  - id: T3
    title: Rework replay export pipeline
    size: large
    outcomes: [passed]
`,
  );
  return runTally({ configPath, dryRun: true, baseline: false, outputDir: options.outputDir, now: options.now });
}
