import type { LedgerRow, RunState } from '../schema/types.js';
export type RoutingCohort = 'prior-only' | 'trace-driven' | 'local-history' | 'unattributed' | 'baseline';
export interface TaskEvidence {
    runId: string;
    repo: string;
    taskId: string;
    cohort: RoutingCohort;
    decision: string | null;
    costNanos: number;
    passed: boolean;
    errored: boolean;
    skipped: boolean;
    attempts: number;
    startupRetries: number;
    size: string | null;
    graphNodes: number | null;
    filesTouched: number | null;
    issueLength: number | null;
    filesNamed: number | null;
    textSource: 'run-query' | 'current-issue' | 'plan-query' | 'missing';
    signalSource?: 'comparison-plan';
    comparisonPass?: 'A' | 'B' | 'C';
    models: string[];
    source: string;
}
export interface Correlation {
    n: number;
    pearson: number | null;
    spearman: number | null;
    interpretation: string;
}
export declare function correlate(input: [number | null, number][]): Correlation;
/** Only closed real runs from an audited manifest; missing metrics remain missing. */
export declare function taskEvidence(run: RunState, ledger: LedgerRow[], source: string, issues?: Record<string, {
    title: string;
    body: string;
}>): TaskEvidence[];
export declare function cohortSummary(tasks: TaskEvidence[], group: RoutingCohort): {
    cohort: RoutingCohort;
    tasks: number;
    passed: number;
    errors: number;
    skipped: number;
    totalCostUsd: number;
    meanCostUsd: number | null;
    successRate: number | null;
};
