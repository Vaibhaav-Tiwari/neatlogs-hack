import type { LedgerRow, RunMode, RunState, TaskSize } from '../schema/types.js';
import { type TaskEvidence } from './evidence.js';
export interface ComparisonOutcome {
    runId: string;
    mode: RunMode;
    repeat: number | null;
    costNanos: number;
    passed: boolean;
    errored: boolean;
    skipped: boolean;
    attempts: number;
    startupRetries: number;
    source: string;
}
export type ComparisonPass = 'A' | 'B' | 'C';
export interface ComparisonRun {
    run: RunState;
    ledger: LedgerRow[];
    path: string;
    pass?: ComparisonPass;
}
/** Joins measured plan signals, never planned spend, to validated real ledgers at the same base. */
export declare function comparisonEvidence(input: unknown, runs: ComparisonRun[]): {
    baseCommit: string;
    measuredAt: string | null;
    rows: {
        taskId: string;
        title: string;
        size: TaskSize;
        filesTouched: number;
        dependents: number | null;
        graphNodes: number | null;
        issueLength: number;
        filesNamed: number;
        query: string | null;
        A: ComparisonOutcome[];
        B: ComparisonOutcome[];
        C: ComparisonOutcome[];
    }[];
    observations: TaskEvidence[];
    summaries: {
        pass: "A" | "B" | "C";
        outcomes: number;
        coveredTasks: number;
        plannedTasks: number;
        attempts: number;
        passed: number;
        startupRetries: number;
        meanCostUsd: number | null;
        successRate: number | null;
    }[];
    excluded: {
        runId: string;
        taskId: string;
        reason: string;
    }[];
};
