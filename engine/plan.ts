import { dirname, resolve } from 'node:path';
import { routeBaseline } from '../agent/baseline.js';
import { PriceHistory } from '../agent/history.js';
import type { BudgetPort, SizingSignalsPort } from '../agent/ports.js';
import { routeTask } from '../agent/router.js';
import { sizeTask } from '../agent/sizer.js';
import { EntireSizingAdapter } from '../adapters/entire.js';
import { RepositorySizingAdapter } from '../adapters/repository-sizing.js';
import { CfoaiBudgetAdapter } from '../adapters/cfoai.js';
import { ConfigBacklogIntake } from '../adapters/github.js';
import { usdToNanos } from '../schema/index.js';
import type { BudgetSource, TallyConfig, TaskSize } from '../schema/index.js';
import { loadConfig } from './config.js';
import { createDryRunPorts } from './dry-run.js';
import { validateRealRunConfig, type PreflightRunner } from './preflight.js';

export interface PlannedTask {
  taskId: string;
  title: string;
  size: TaskSize;
  confidence: number;
  tier: string | null;
  model: string | null;
  harness: string | null;
  ceilingNanos: number | null;
  decision: string;
  skipped: boolean;
}

export interface PlanOptions {
  configPath: string;
  dryRun: boolean;
  baseline: boolean;
  budgetUsd?: number;
  only?: string;
  signals?: SizingSignalsPort;
  preflightRunner?: PreflightRunner;
  budgetInfo?: PlanBudgetInfo;
}

export interface PlanBudgetInfo {
  source: BudgetSource;
  limitNanos: number;
  monthlyLimitNanos: number;
  limitSource: BudgetSource | 'cli';
}

class PlanBudget implements BudgetPort {
  private reservedNanos = 0;
  constructor(private readonly limitNanos: number) {}
  async remainingNanos(): Promise<number> {
    return this.limitNanos - this.reservedNanos;
  }
  reserve(ceilingNanos: number | null): void {
    this.reservedNanos += ceilingNanos ?? 0;
  }
}

export async function readPlanBudget(config: TallyConfig, options: Pick<PlanOptions, 'budgetUsd'>): Promise<PlanBudgetInfo> {
  let source: BudgetSource = 'config';
  let monthlyLimitNanos = usdToNanos(config.budget.usd);
  if (config.budget.source === 'cfoai' || config.integrations.cfoai) {
    const adapter = new CfoaiBudgetAdapter({ config: config.budget.cfoai });
    try {
      monthlyLimitNanos = await adapter.budgetLimitNanos();
      source = 'cfoai';
    } catch {
      // Keep the configured fallback explicit when the read fails.
    } finally { await adapter.close(); }
  }
  return { source, monthlyLimitNanos,
    limitNanos: options.budgetUsd !== undefined ? usdToNanos(options.budgetUsd) : config.budget.source === 'cfoai' ? monthlyLimitNanos : usdToNanos(config.budget.usd),
    limitSource: options.budgetUsd !== undefined ? 'cli' : config.budget.source === 'cfoai' ? source : 'config' };
}

export async function planTally(options: PlanOptions): Promise<PlannedTask[]> {
  const config = loadConfig(options.configPath);
  if (!options.dryRun) await validateRealRunConfig(config, options.configPath, options.preflightRunner);
  const configDir = dirname(options.configPath);
  const dryRunPorts = options.dryRun ? createDryRunPorts({ config, configPath: options.configPath }) : {};
  const signals =
    options.signals ??
    dryRunPorts.signals ??
    (config.integrations.entire ? new EntireSizingAdapter({ repoPath: resolve(configDir, config.repo.path) }) : new RepositorySizingAdapter({ repoPath: resolve(configDir, config.repo.path) }));
  const intake = dryRunPorts.intake ?? new ConfigBacklogIntake();
  const tasks = (await intake.tasks(config, options.configPath)).filter((task) => {
    if (options.only === undefined) return true;
    return task.taskId === options.only || String(task.issueNumber) === options.only;
  });
  const budgetInfo = options.budgetInfo ?? await readPlanBudget(config, options);
  const budget = new PlanBudget(budgetInfo.limitNanos);
  const history = new PriceHistory();
  const planned: PlannedTask[] = [];
  for (const task of tasks) {
    const taskInput = { taskId: task.taskId, title: task.title, body: task.body };
    const estimate = await sizeTask(taskInput, { signals });
    const route = options.baseline
      ? await routeBaseline({ task: taskInput, estimate, config, ports: { budget, history } })
      : await routeTask({ task: taskInput, estimate, config, ports: { budget, history } });
    if (route.action === 'start') {
      const ceiling = task.firstAttemptCeilingUsd === undefined || options.baseline ? route.ceilingNanos : Math.min(route.ceilingNanos ?? Infinity, usdToNanos(task.firstAttemptCeilingUsd));
      budget.reserve(ceiling);
      planned.push({
        taskId: task.taskId,
        title: task.title,
        size: estimate.size,
        confidence: estimate.confidence,
        tier: route.tier.name,
        model: route.tier.model,
        harness: route.tier.harness,
        ceilingNanos: ceiling,
        decision: task.firstAttemptCeilingUsd === undefined || options.baseline ? route.reason : `${route.reason} Deliberate first-attempt ceiling override: $${task.firstAttemptCeilingUsd.toFixed(3)} (normal ceiling remains an upper bound).`,
        skipped: false,
      });
    } else {
      planned.push({
        taskId: task.taskId,
        title: task.title,
        size: estimate.size,
        confidence: estimate.confidence,
        tier: null,
        model: null,
        harness: null,
        ceilingNanos: null,
        decision: route.reason,
        skipped: true,
      });
    }
  }
  return planned;
}
