import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AoCliAdapter } from '../adapters/ao.js';
import { ConfigBacklogIntake } from '../adapters/github.js';
import { checkCeiling } from '../agent/watcher.js';
import { nanosToUsd, usdToNanos } from '../schema/money.js';
import { loadConfig } from './config.js';
import { createDryRunPorts } from './dry-run.js';
import { RunError, runTally } from './run.js';
import { writeRunFiles } from './output.js';
const execFileAsync = promisify(execFile);
export const EXPERIMENT_CAP_REASON = 'stopped: experiment cap reached';
function spread(values) {
    // Undefined cost per pass must not disappear from the comparison.
    if (!values.length || values.some((value) => value === null))
        return { min: null, median: null, max: null };
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1) };
}
function percent(before, after) {
    return before === null || after === null || before === 0 ? null : (after - before) / before * 100;
}
export function updateExperimentSummary(summary, result, repeat) {
    const run = result.runState;
    const passed = run.tasks.filter((task) => task.status === 'passed').length;
    const mode = summary.modes[run.mode];
    mode.runs.push({ runId: run.runId, repeat, path: `/runs/${encodeURIComponent(run.runId)}/`, status: run.status,
        tasks: run.tasks.length, passed, failed: run.tasks.filter((task) => task.status === 'failed').length,
        skipped: run.tasks.filter((task) => task.status === 'skipped').length, attempts: run.tasks.reduce((sum, task) => sum + task.attempts, 0),
        totalCostNanos: run.budget.spentNanos, costPerPassedTaskNanos: passed ? run.budget.spentNanos / passed : null,
        passRate: run.tasks.length ? passed / run.tasks.length : 0,
        neatlogsSessionId: run.integrations.neatlogs.status === 'ok' ? run.runId : null });
    summary.budget.spentNanos += run.budget.spentNanos;
    for (const task of run.tasks) {
        const entry = summary.perTask.find((item) => item.taskId === task.taskId);
        if (!entry)
            throw new RunError([`experiment backlog changed: unexpected task ${task.taskId}`]);
        entry[run.mode].push({ runId: run.runId, repeat, tier: task.tier, model: task.model, result: task.status, attempts: task.attempts, costNanos: task.spentNanos });
    }
    for (const value of Object.values(summary.modes)) {
        const finished = value.runs.filter((item) => item.status === 'finished');
        value.totalCostNanos = spread(finished.map((item) => item.totalCostNanos));
        value.costPerPassedTaskNanos = spread(finished.map((item) => item.costPerPassedTaskNanos));
        value.passRate = spread(finished.map((item) => item.passRate));
    }
    const baseline = summary.modes.baseline;
    const tally = summary.modes.tally;
    summary.comparison.totalCostChangePct = percent(baseline.totalCostNanos.median, tally.totalCostNanos.median);
    summary.comparison.costPerPassedTaskChangePct = percent(baseline.costPerPassedTaskNanos.median, tally.costPerPassedTaskNanos.median);
    summary.comparison.passRateChangePoints = baseline.passRate.median === null || tally.passRate.median === null ? null : (tally.passRate.median - baseline.passRate.median) * 100;
}
export function writeExperimentSummary(path, summary) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
    renameSync(temporary, path);
}
/** A separate safety budget; it never changes a route's per-task ceiling. */
export class ExperimentWorker {
    ports;
    capNanos;
    spentBeforeNanos;
    intervalMs;
    costs = new Map();
    inputs = new Map();
    closed = new Set();
    reason = null;
    constructor(ports, capNanos, spentBeforeNanos, intervalMs = 1000) {
        this.ports = ports;
        this.capNanos = capNanos;
        this.spentBeforeNanos = spentBeforeNanos;
        this.intervalMs = intervalMs;
    }
    get spent() { return this.spentBeforeNanos + [...this.costs.values()].reduce((sum, cost) => sum + cost, 0); }
    stopReason() { return this.reason ?? (this.spent >= this.capNanos ? EXPERIMENT_CAP_REASON : null); }
    async start(input) {
        const reason = this.stopReason();
        if (reason)
            throw new RunError([reason]);
        const started = await this.ports.worker.start(input);
        this.inputs.set(started.sessionId, input);
        this.costs.set(started.sessionId, 0);
        return started;
    }
    async commitChanges(sessionId) {
        return await this.ports.worker.commitChanges?.(sessionId) ?? null;
    }
    record(sessionId, usage) {
        const input = this.inputs.get(sessionId);
        if (usage && input)
            this.costs.set(sessionId, Math.max(this.costs.get(sessionId) ?? 0, checkCeiling(usage, { sessionId, tier: input.tier, ceilingNanos: null }).costNanos));
        return usage;
    }
    async usageFor(sessionId) { return this.record(sessionId, await this.ports.usage.usageFor(sessionId)); }
    async settledUsageFor(sessionId) {
        const port = this.ports.usage;
        return this.record(sessionId, await (port.settledUsageFor?.(sessionId) ?? port.usageFor(sessionId)));
    }
    async stop(sessionId, reason) {
        if (this.closed.has(sessionId))
            return;
        try {
            await this.ports.sessions.stop(sessionId, reason);
        }
        catch (error) {
            throw new RunError([`could not close experiment worker ${sessionId}: ${error instanceof Error ? error.message : String(error)}`]);
        }
        this.closed.add(sessionId);
    }
    async closeAll(reason) {
        for (const sessionId of this.inputs.keys()) {
            await this.stop(sessionId, reason);
            await this.settledUsageFor(sessionId);
        }
    }
    async wait(sessionId, options) {
        const abort = new AbortController();
        const watch = async () => {
            while (!abort.signal.aborted) {
                try {
                    await this.usageFor(sessionId);
                }
                catch {
                    this.reason = 'stopped: experiment usage unavailable';
                }
                const reason = this.stopReason();
                if (reason) {
                    this.reason = reason;
                    await this.stop(sessionId, reason);
                    return { status: 'experiment_stop', branch: null, checkoutPath: null, prUrl: null, resultReason: reason };
                }
                try {
                    await delay(this.intervalMs, undefined, { signal: abort.signal });
                }
                catch {
                    return null;
                }
            }
            return null;
        };
        const watched = watch();
        let result;
        try {
            result = await Promise.race([watched, this.ports.worker.wait(sessionId, options)]);
        }
        finally {
            abort.abort();
            await watched;
        }
        if (!result)
            throw new RunError(['experiment watcher ended before worker completion']);
        return this.reason ? { ...result, status: 'experiment_stop', resultReason: this.reason } : result;
    }
}
export async function runExperiment(options) {
    if (!options.dryRun && !options.allowReal)
        throw new RunError(['real experiments start paid workers; use --yes with an explicit --budget to approve, or --dry-run']);
    if (!options.dryRun && options.budgetUsd === undefined)
        throw new RunError(['real experiments require an explicit aggregate --budget']);
    const repeats = options.repeats ?? 2;
    if (!Number.isInteger(repeats) || repeats < 1)
        throw new RunError(['--repeats must be a positive integer']);
    const configPath = resolve(options.configPath);
    const config = loadConfig(configPath);
    if (!options.dryRun && (config.runner ?? 'ao') !== 'ao')
        throw new RunError(['real experiments currently require runner: ao']);
    if (!options.dryRun && !config.test.timeoutSec)
        throw new RunError(['real experiments require test.timeoutSec for a bounded wall-clock wait']);
    const repoPath = resolve(dirname(configPath), config.repo.path);
    let baseCommit = options.baseCommit;
    if (!baseCommit) {
        try {
            baseCommit = (await execFileAsync('git', ['rev-parse', '--verify', '--end-of-options', `${config.repo.baseBranch}^{commit}`], { cwd: repoPath })).stdout.trim();
        }
        catch {
            throw new RunError([`could not determine experiment base commit in ${repoPath}`]);
        }
    }
    if (!/^[a-f0-9]{40}$/.test(baseCommit))
        throw new RunError(['experiment base must be a full Git commit SHA']);
    const intake = options.ports?.intake ?? new ConfigBacklogIntake();
    const tasks = (await intake.tasks(config, configPath)).filter((task) => options.only === undefined || task.taskId === options.only || String(task.issueNumber) === options.only);
    if (!tasks.length)
        throw new RunError(['experiment backlog contains no selected tasks']);
    const capNanos = usdToNanos(options.budgetUsd ?? config.budget.usd);
    if (!Number.isSafeInteger(capNanos) || capNanos <= 0)
        throw new RunError(['experiment budget must be positive and finite']);
    const now = options.now ?? (() => new Date());
    const started = now();
    const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
    const experimentId = `exp-${stamp}`;
    const runsDir = resolve(options.runsDir ?? '.tally/runs');
    const summaryPath = join(runsDir, 'experiments', experimentId, 'summary.json');
    if (existsSync(summaryPath))
        throw new RunError([`experiment already exists: ${experimentId}`]);
    const empty = () => ({ runs: [], totalCostNanos: spread([]), costPerPassedTaskNanos: spread([]), passRate: spread([]) });
    const summary = { schemaVersion: 1, experimentId, status: 'running', real: !options.dryRun,
        repo: config.repo.slug ?? config.repo.path, baseCommit, taskIds: tasks.map((task) => task.taskId), repeatsPlanned: repeats,
        startedAt: started.toISOString(), endedAt: null, budget: { capNanos, spentNanos: 0 }, modes: { baseline: empty(), tally: empty() },
        perTask: tasks.map((task) => ({ taskId: task.taskId, baseline: [], tally: [] })),
        comparison: { totalCostChangePct: null, costPerPassedTaskChangePct: null, passRateChangePoints: null, note: 'medians of the repeats; negative cost change means Tally was cheaper' } };
    writeExperimentSummary(summaryPath, summary);
    try {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
            for (const mode of ['baseline', 'tally']) {
                const interrupted = options.stopRequested?.();
                if (interrupted || summary.budget.spentNanos >= capNanos) {
                    summary.status = 'stopped';
                    summary.reason = interrupted ?? EXPERIMENT_CAP_REASON;
                    break;
                }
                const defaults = options.dryRun ? { ...createDryRunPorts({ config, configPath }),
                    worktrees: { commitFor: async () => baseCommit, checkoutPathFor: async () => null } } : (() => {
                    const ao = new AoCliAdapter({ cwd: repoPath, project: config.repo.aoProject, requiredBaseCommit: baseCommit });
                    return { worker: ao, usage: ao, sessions: ao };
                })();
                const ports = { ...defaults, ...options.ports };
                const guarded = new ExperimentWorker({ worker: ports.worker, usage: ports.usage, sessions: ports.sessions }, capNanos, summary.budget.spentNanos, options.dryRun ? 1 : 1000);
                const runId = `run-${stamp}-${mode}-${repeat}`;
                const outputDir = join(runsDir, runId);
                if (existsSync(outputDir))
                    throw new RunError([`experiment run directory already exists: ${outputDir}`]);
                await options.beforeRun?.({ runId, mode, repeat, outputDir });
                let result;
                try {
                    result = await runTally({ configPath, dryRun: options.dryRun, baseline: mode === 'baseline',
                        budgetUsd: nanosToUsd(capNanos - summary.budget.spentNanos), outputDir, latestRunDir: join(runsDir, 'latest'), now, runId, repeat, requiredBaseCommit: baseCommit,
                        publish: false, parallel: 1, onEvent: options.onEvent,
                        stopRequested: () => options.stopRequested?.() ?? guarded.stopReason(), ports: { ...ports, intake: { tasks: async () => structuredClone(tasks) }, worker: guarded, usage: guarded, sessions: guarded } });
                }
                catch (error) {
                    await guarded.closeAll('experiment run failed');
                    const runPath = join(outputDir, 'run.json');
                    const ledgerPath = join(outputDir, 'ledger.json');
                    if (existsSync(runPath) && existsSync(ledgerPath)) {
                        const runState = JSON.parse(readFileSync(runPath, 'utf8'));
                        const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
                        runState.status = 'interrupted';
                        runState.endedAt = now().toISOString();
                        const written = writeRunFiles(outputDir, runState, ledger, join(runsDir, 'latest'));
                        updateExperimentSummary(summary, { ...written, runState, ledger }, repeat);
                    }
                    throw error;
                }
                updateExperimentSummary(summary, result, repeat);
                const stopReason = options.stopRequested?.() ?? guarded.stopReason();
                if (stopReason) {
                    summary.status = 'stopped';
                    summary.reason = stopReason;
                }
                writeExperimentSummary(summaryPath, summary);
                if (summary.status === 'stopped')
                    break;
            }
            if (summary.status === 'stopped')
                break;
        }
        if (summary.status === 'running')
            summary.status = 'finished';
    }
    catch (error) {
        summary.status = 'stopped';
        summary.reason = error instanceof Error ? error.message : String(error);
        throw error instanceof RunError ? error : new RunError([summary.reason]);
    }
    finally {
        summary.endedAt = now().toISOString();
        writeExperimentSummary(summaryPath, summary);
    }
    return { summary, summaryPath };
}
//# sourceMappingURL=experiment.js.map