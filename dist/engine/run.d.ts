import type { Ledger, RunState } from '../schema/index.js';
import { type RealRunOptions } from './real.js';
import { type PreflightRunner } from './preflight.js';
export type RunProgress = {
    type: 'budget';
    budget: RunState['budget'];
} | {
    type: 'route';
    taskId: string;
    size: string;
    confidence: number;
    tier: string | null;
    harness: string | null;
    model: string | null;
    ceilingNanos: number | null;
    decision: string;
} | {
    type: 'worker';
    taskId: string;
    attempt: number;
    sessionId: string;
    tier: string;
} | {
    type: 'spend';
    taskId: string;
    attempt: number;
    costNanos: number;
} | {
    type: 'result';
    row: Ledger[number];
};
export interface RunOptions {
    configPath: string;
    dryRun: boolean;
    baseline: boolean;
    budgetUsd?: number;
    parallel?: number;
    only?: string;
    outputDir?: string;
    latestRunDir?: string;
    now?: () => Date;
    preflightRunner?: PreflightRunner;
    /** Experiment pin: reject a different resolved repository base before starting workers. */
    requiredBaseCommit?: string;
    runId?: string;
    repeat?: number;
    stopRequested?: () => string | null;
    /** Experiments verify local commits without pushing branches or opening PRs. */
    publish?: boolean;
    onEvent?: (event: RunProgress) => void;
}
export interface RunResult {
    runState: RunState;
    ledger: Ledger;
    outputDir: string;
    runStatePath: string;
    ledgerPath: string;
    latestRunDir: string;
}
export declare class RunError extends Error {
    readonly problems: string[];
    constructor(problems: string[]);
}
export declare function runTally(options: RunOptions | RealRunOptions): Promise<RunResult>;
export declare function runDemo(options?: Pick<RunOptions, 'outputDir' | 'latestRunDir' | 'now' | 'onEvent'> & {
    live?: boolean;
}): Promise<RunResult>;
