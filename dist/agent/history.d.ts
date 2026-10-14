import type { TallyConfig, TaskSize } from '../schema/types.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistoryWriterPort, PriceStats } from './ports.js';
export interface Prior {
    passRate: number;
    avgCostNanos: number;
}
/** A prior blended with what was observed. `attempts` counts observations only. */
export interface Estimate extends Prior {
    attempts: number;
}
/** How many observed attempts the prior is worth. */
export declare const DEFAULT_PRIOR_WEIGHT = 2;
/** Position of a tier in the config, from 0 (cheapest) to 1 (strongest). */
export declare function tierRank(config: TallyConfig, tierName: string): number;
/**
 * The assumption used when a (size, tier) pair has no history: the pass rate
 * rises with the tier's position, and an attempt costs its full ceiling.
 */
export declare function priorFor(config: TallyConfig, size: TaskSize, tierName: string): Prior;
export declare function blend(observed: PriceStats | null, prior: Prior, priorWeight?: number): Estimate;
/** Pass rate and average cost to plan with. Never fails: unreadable history means the prior. */
export declare function estimateFor(config: TallyConfig, history: PriceHistoryPort | undefined, size: TaskSize, tierName: string, priorWeight?: number): Promise<Estimate>;
interface Cell {
    attempts: number;
    passes: number;
    totalCostNanos: number;
    successfulCostsNanos?: number[];
}
export interface PriceHistorySnapshot {
    version: 1;
    /** Model cells use JSON [size, tier, model]; legacy `${size}:${tier}` cells remain audit-only. */
    cells: Record<string, Cell>;
}
/**
 * Local history, kept in memory. The engine saves `snapshot()` wherever it
 * keeps run output and passes it back in on the next run.
 */
export declare class PriceHistory implements PriceHistoryPort, PriceHistoryWriterPort {
    private readonly cells;
    constructor(snapshot?: PriceHistorySnapshot);
    lookup(size: TaskSize, tier: string, model?: string): Promise<PriceStats | null>;
    record(outcome: AttemptOutcome): Promise<void>;
    snapshot(): PriceHistorySnapshot;
}
export {};
