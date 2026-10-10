import { dirname, resolve } from 'node:path';
import { routeBaseline } from '../agent/baseline.js';
import { PriceHistory } from '../agent/history.js';
import type { BudgetPort, SizingSignalsPort } from '../agent/ports.js';
import { routeTask } from '../agent/router.js';
import { sizeTask } from '../agent/sizer.js';
import { EntireSizingAdapter } from '../adapters/entire.js';
import { ConfigBacklogIntake } from '../adapters/github.js';
import { usdToNanos } from '../schema/index.js';
import type { TaskSize } from '../schema/index.js';
import { loadConfig } from './config.js';
import { createDryRunPorts } from './dry-run.js';
import { validateRealRunConfig, type PreflightRunner } from './preflight.js';

export interface PlannedTask {
  taskId: string;
  title: string;
  size: TaskSize;
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

const nullSignals: SizingSignalsPort = {
  async signalsFor() {
    return null;
  },
};

export async function planTally(options: PlanOptions): Promise<PlannedTask[]> {
  const config = loadConfig(options.configPath);
  if (!options.dryRun) await validateRealRunConfig(config, options.configPath, options.preflightRunner);
  const configDir = dirname(options.configPath);
  const dryRunPorts = options.dryRun ? createDryRunPorts() : {};
  const signals =
    options.signals ??
    dryRunPorts.signals ??
    (config.integrations.entire ? new EntireSizingAdapter({ repoPath: resolve(configDir, config.repo.path) }) : nullSignals);
  const intake = dryRunPorts.intake ?? new ConfigBacklogIntake();
  const tasks = (await intake.tasks(config, options.configPath)).filter((task) => {
    if (options.only === undefined) return true;
    return task.taskId === options.only || String(task.issueNumber) === options.only;
  });
  const budget = new PlanBudget(usdToNanos(options.budgetUsd ?? config.budget.usd));
  const history = new PriceHistory();
  const planned: PlannedTask[] = [];
  for (const task of tasks) {
    const taskInput = { taskId: task.taskId, title: task.title, body: task.body };
    const estimate = await sizeTask(taskInput, { signals });
    const route = options.baseline
      ? await routeBaseline({ task: taskInput, estimate, config, ports: { budget, history } })
      : await routeTask({ task: taskInput, estimate, config, ports: { budget, history } });
    if (route.action === 'start') {
      budget.reserve(route.ceilingNanos);
      planned.push({
        taskId: task.taskId,
        title: task.title,
        size: estimate.size,
        tier: route.tier.name,
        model: route.tier.model,
        harness: route.tier.harness,
        ceilingNanos: route.ceilingNanos,
        decision: route.reason,
        skipped: false,
      });
    } else {
      planned.push({
        taskId: task.taskId,
        title: task.title,
        size: estimate.size,
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
