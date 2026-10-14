import type { TallyConfig, TaskSize, Tier, TierPrice, TokenUsage } from './types.js';
export declare const NANOS_PER_USD = 1000000000;
export declare function usdToNanos(usd: number): number;
export declare function nanosToUsd(nanos: number): number;
/** Keep cents compact, but never round a fractional-cent cost to zero. */
export declare function formatUsd(nanos: number): string;
/** Tokens x list price, in nanos. A price per million tokens is 1000 nanos per token per USD. */
export declare function costNanos(tokens: TokenUsage, price: TierPrice): number;
/** The spend ceiling for one attempt: the size ceiling scaled by the tier's fraction. */
export declare function ceilingNanos(config: TallyConfig, size: TaskSize, tier: Tier): number;
export declare function attemptId(runId: string, taskId: string, attempt: number): string;
