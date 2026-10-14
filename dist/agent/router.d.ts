import type { TallyConfig, TaskSize, Tier } from '../schema/types.js';
import type { BudgetPort, PriceHistoryPort, TaskInput, TraceAttributes, TracePort } from './ports.js';
import { type HistoryPlan } from './history-plan.js';
import type { SizeEstimate } from './sizer.js';
export interface RoutingOptions {
    /**
     * Kept for compatibility with older callers; routing now derives the
     * confidence needed for each cheaper tier from the expected-cost rule.
     */
    cheapConfidence?: number;
    /** How many observed attempts the prior is worth. */
    priorWeight: number;
    /** Observations needed before routing trusts a history cell over the prior. */
    minHistoryAttempts: number;
    /**
     * When the budget rules out the preferred tier, a cheaper one is tried
     * only if it is expected to pass at least this often.
     */
    minPassRateOnTightBudget: number;
}
export declare const DEFAULT_ROUTING: RoutingOptions;
export interface StartDecision {
    action: 'start';
    taskId: string;
    size: TaskSize;
    confidence: number;
    /** The tier to run, straight from tally.yaml. */
    tier: Tier;
    /** Spend ceiling for the attempt. Null means no ceiling (baseline mode only). */
    ceilingNanos: number | null;
    /** Ceiling plus the chance of failing times the top cost; for the top tier, its estimated cost. */
    expectedCostNanos: number;
    /** Estimated cost of sending this task straight to the strongest tier. */
    topCostNanos: number;
    /** One plain-English sentence, shown on the dashboard and stored on the ledger row. */
    reason: string;
    history?: HistoryPlan[];
}
export interface SkipDecision {
    action: 'skip';
    taskId: string;
    size: TaskSize;
    confidence: number;
    /** Goes into TaskState.statusReason. */
    statusReason: 'not started: no budget';
    reason: string;
    history?: HistoryPlan[];
}
export type RouteDecision = StartDecision | SkipDecision;
export interface RouteInput {
    task: TaskInput;
    estimate: SizeEstimate;
    config: TallyConfig;
    ports: {
        history?: PriceHistoryPort;
        budget: BudgetPort;
        trace?: TracePort;
    };
    options?: Partial<RoutingOptions>;
    traceAttributes?: TraceAttributes;
}
export declare function usd(nanos: number): string;
export declare function routeTask(input: RouteInput): Promise<RouteDecision>;
