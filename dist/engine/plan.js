import { dirname, resolve } from 'node:path';
import { routeBaseline } from '../agent/baseline.js';
import { routeTask } from '../agent/router.js';
import { sizeTask } from '../agent/sizer.js';
import { EntireSizingAdapter } from '../adapters/entire.js';
import { RepositorySizingAdapter } from '../adapters/repository-sizing.js';
import { CfoaiBudgetAdapter } from '../adapters/cfoai.js';
import { ConfigBacklogIntake } from '../adapters/github.js';
import { usdToNanos } from '../schema/index.js';
import { loadConfig } from './config.js';
import { createDryRunPorts } from './dry-run.js';
import { createPriceHistory } from './price-history.js';
import { validateRealRunConfig } from './preflight.js';
class PlanBudget {
    limitNanos;
    reservedNanos = 0;
    constructor(limitNanos) {
        this.limitNanos = limitNanos;
    }
    async remainingNanos() {
        return this.limitNanos - this.reservedNanos;
    }
    reserve(ceilingNanos) {
        this.reservedNanos += ceilingNanos ?? 0;
    }
}
function trackHistorySources(history, sources) {
    return {
        async lookup(size, tier, model) {
            const stats = await history.lookup(size, tier, model);
            if (stats && stats.attempts > 0) {
                const source = history.sourceOfLastLookup?.() ?? 'local';
                if (source !== 'none')
                    sources.add(source);
            }
            return stats;
        },
    };
}
export async function readPlanBudget(config, options) {
    let source = 'config';
    let monthlyLimitNanos = usdToNanos(config.budget.usd);
    let monthlySpentNanos = 0;
    let warning;
    if (config.budget.source === 'cfoai' || config.integrations.cfoai) {
        const adapter = new CfoaiBudgetAdapter({ config: config.budget.cfoai });
        try {
            const [limit, spent] = await Promise.all([adapter.budgetLimitNanos(), adapter.currentSpendNanos()]);
            monthlyLimitNanos = limit;
            monthlySpentNanos = spent;
            source = 'cfoai';
        }
        catch {
            // Keep the configured fallback explicit when the read fails.
            warning = 'cfo.ai budget read failed; this preview uses the tally.yaml fallback. Check `tally doctor` before starting a real run.';
        }
        finally {
            await adapter.close();
        }
    }
    const limitNanos = options.budgetUsd !== undefined ? usdToNanos(options.budgetUsd) : config.budget.source === 'cfoai' ? monthlyLimitNanos : usdToNanos(config.budget.usd);
    return { source, monthlyLimitNanos, monthlySpentNanos, monthlyRemainingNanos: Math.max(0, monthlyLimitNanos - monthlySpentNanos),
        limitNanos,
        limitSource: options.budgetUsd !== undefined ? 'cli' : config.budget.source === 'cfoai' ? source : 'config',
        ...(warning ? { warning } : {}) };
}
export async function planTally(options) {
    const config = loadConfig(options.configPath);
    if (!options.dryRun)
        await validateRealRunConfig(config, options.configPath, options.preflightRunner);
    const configDir = dirname(options.configPath);
    const dryRunPorts = options.dryRun ? createDryRunPorts({ config, configPath: options.configPath }) : {};
    const signals = options.signals ??
        dryRunPorts.signals ??
        (config.integrations.entire ? new EntireSizingAdapter({ repoPath: resolve(configDir, config.repo.path) }) : new RepositorySizingAdapter({ repoPath: resolve(configDir, config.repo.path) }));
    const intake = dryRunPorts.intake ?? new ConfigBacklogIntake();
    const tasks = (await intake.tasks(config, options.configPath)).filter((task) => {
        if (options.only === undefined)
            return true;
        return task.taskId === options.only || String(task.issueNumber) === options.only;
    });
    const budgetInfo = options.budgetInfo ?? await readPlanBudget(config, options);
    const budget = new PlanBudget(Math.min(budgetInfo.limitNanos, budgetInfo.monthlyRemainingNanos));
    const historyPort = createPriceHistory(config, options.configPath);
    const planned = [];
    let historyDetailReported = false;
    for (const task of tasks) {
        const taskInput = { taskId: task.taskId, title: task.title, body: task.body };
        const estimate = await sizeTask(taskInput, { signals });
        const graph = signals.status?.();
        const entire = config.integrations.entire && graph ? { ...graph, detail: signals.detailFor ? signals.detailFor(taskInput) : graph.detail } : undefined;
        const historySources = new Set();
        const route = options.baseline
            ? await routeBaseline({ task: taskInput, estimate, config, ports: { budget, history: trackHistorySources(historyPort, historySources) } })
            : await routeTask({ task: taskInput, estimate, config, ports: { budget, history: trackHistorySources(historyPort, historySources) } });
        const sources = historySources.size > 0 ? [...historySources].sort() : ['none'];
        const historyState = config.integrations.neatlogs ? historyPort.status?.() : null;
        const historyDetail = !historyDetailReported && (historyState?.status === 'error' || historyState?.status === 'missing')
            ? historyState.detail ?? undefined : undefined;
        if (historyDetail)
            historyDetailReported = true;
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
                historySources: sources,
                ...(entire ? { entire } : {}),
                ...(historyDetail ? { historyDetail } : {}),
                skipped: false,
            });
        }
        else {
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
                historySources: sources,
                ...(entire ? { entire } : {}),
                ...(historyDetail ? { historyDetail } : {}),
                skipped: true,
            });
        }
    }
    return planned;
}
//# sourceMappingURL=plan.js.map