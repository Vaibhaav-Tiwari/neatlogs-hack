import type { LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { RunMode, RunState } from '../schema/types.js';
import type { FinalUsagePort, RealRunPorts, WorkerPort, WorkerResult, WorkerStartInput } from './real.js';
import { type RunOptions, type RunResult } from './run.js';
export declare const EXPERIMENT_CAP_REASON = "stopped: experiment cap reached";
type Spread = {
    min: number | null;
    median: number | null;
    max: number | null;
};
export interface ExperimentRun {
    runId: string;
    repeat: number;
    path: string;
    status: RunState['status'];
    tasks: number;
    passed: number;
    failed: number;
    skipped: number;
    attempts: number;
    totalCostNanos: number;
    costPerPassedTaskNanos: number | null;
    passRate: number;
    neatlogsSessionId: string | null;
}
interface ModeSummary {
    runs: ExperimentRun[];
    totalCostNanos: Spread;
    costPerPassedTaskNanos: Spread;
    passRate: Spread;
}
interface TaskOutcome {
    runId: string;
    repeat: number;
    tier: string | null;
    model: string | null;
    result: string;
    attempts: number;
    costNanos: number;
}
export interface ExperimentSummary {
    schemaVersion: 1;
    experimentId: string;
    status: 'running' | 'finished' | 'stopped';
    real: boolean;
    repo: string;
    baseCommit: string;
    taskIds: string[];
    repeatsPlanned: number;
    startedAt: string;
    endedAt: string | null;
    budget: {
        capNanos: number;
        spentNanos: number;
    };
    modes: Record<RunMode, ModeSummary>;
    perTask: Array<{
        taskId: string;
        baseline: TaskOutcome[];
        tally: TaskOutcome[];
    }>;
    comparison: {
        totalCostChangePct: number | null;
        costPerPassedTaskChangePct: number | null;
        passRateChangePoints: number | null;
        note: string;
    };
    reason?: string;
}
export declare function updateExperimentSummary(summary: ExperimentSummary, result: RunResult, repeat: number): void;
export declare function writeExperimentSummary(path: string, summary: ExperimentSummary): void;
/** A separate safety budget; it never changes a route's per-task ceiling. */
export declare class ExperimentWorker implements WorkerPort, FinalUsagePort, SessionControlPort {
    private readonly ports;
    private readonly capNanos;
    private readonly spentBeforeNanos;
    private readonly intervalMs;
    private readonly costs;
    private readonly inputs;
    private readonly closed;
    reason: string | null;
    constructor(ports: {
        worker: WorkerPort;
        usage: LiveUsagePort;
        sessions: SessionControlPort;
    }, capNanos: number, spentBeforeNanos: number, intervalMs?: number);
    private get spent();
    stopReason(): string | null;
    start(input: WorkerStartInput): Promise<{
        sessionId: string;
        branch: string | null;
        checkoutPath: string | null;
        setupDurationMs?: number;
    }>;
    commitChanges(sessionId: string): Promise<string | null>;
    private record;
    usageFor(sessionId: string): Promise<import("../agent/ports.js").LiveUsage | null>;
    settledUsageFor(sessionId: string): Promise<import("../agent/ports.js").LiveUsage | null>;
    stop(sessionId: string, reason: string): Promise<void>;
    closeAll(reason: string): Promise<void>;
    wait(sessionId: string, options?: {
        timeoutMs?: number;
    }): Promise<WorkerResult>;
}
export interface ExperimentOptions {
    configPath: string;
    dryRun: boolean;
    repeats?: number;
    budgetUsd?: number;
    only?: string;
    runsDir?: string;
    now?: () => Date;
    baseCommit?: string;
    ports?: Partial<RealRunPorts>;
    allowReal?: boolean;
    onEvent?: RunOptions['onEvent'];
    beforeRun?: (run: {
        runId: string;
        mode: RunMode;
        repeat: number;
        outputDir: string;
    }) => Promise<void>;
    stopRequested?: () => string | null;
}
export declare function runExperiment(options: ExperimentOptions): Promise<{
    summary: ExperimentSummary;
    summaryPath: string;
}>;
export {};
