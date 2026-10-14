import type { TallyConfig, TaskSize } from '../schema/types.js';
import type { PriceHistoryPort, PriceHistorySource } from './ports.js';
export interface HistoryPlan {
    tier: string;
    model: string;
    size: TaskSize;
    attempts: number;
    source: PriceHistorySource | 'unknown';
    usedPrior: boolean;
    passRate: number;
    avgCostNanos: number;
    observedPassRate: number | null;
    observedAvgCostNanos: number | null;
    configuredCeilingNanos: number;
    ceilingNanos: number;
    capSource: 'config' | 'successful-p90';
    successfulSamples: number;
    p90CostNanos: number | null;
}
/** Failed/stopped costs are censored: they cannot estimate the cost to finish. */
export declare function planFromHistory(config: TallyConfig, history: PriceHistoryPort | undefined, size: TaskSize, tierName: string, minHistoryAttempts?: number): Promise<HistoryPlan>;
