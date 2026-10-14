import type { PriceHistorySource, SizingSignalsPort } from '../agent/ports.js';
import type { BudgetSource, IntegrationState, TallyConfig, TaskSize } from '../schema/index.js';
import { type PreflightRunner } from './preflight.js';
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
    /** Sources that returned observations for this task's routing decision. */
    historySources: PriceHistorySource[];
    /** Read-only integration issue surfaced once by the CLI plan view. */
    historyDetail?: string;
    entire?: IntegrationState;
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
    monthlySpentNanos: number;
    monthlyRemainingNanos: number;
    limitSource: BudgetSource | 'cli';
    warning?: string;
}
export declare function readPlanBudget(config: TallyConfig, options: Pick<PlanOptions, 'budgetUsd'>): Promise<PlanBudgetInfo>;
export declare function planTally(options: PlanOptions): Promise<PlannedTask[]>;
