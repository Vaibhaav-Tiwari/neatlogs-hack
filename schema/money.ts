import type { TallyConfig, TaskSize, Tier, TierPrice, TokenUsage } from './types.js';

export const NANOS_PER_USD = 1_000_000_000;

export function usdToNanos(usd: number): number {
  return Math.round(usd * NANOS_PER_USD);
}

export function nanosToUsd(nanos: number): number {
  return nanos / NANOS_PER_USD;
}

/** Keep cents compact, but never round a fractional-cent cost to zero. */
export function formatUsd(nanos: number): string {
  const usd = nanosToUsd(nanos);
  const digits = nanos % 10_000_000 === 0 ? 2 : Math.min(9, Math.max(4, usd === 0 ? 4 : Math.ceil(-Math.log10(Math.abs(usd))) + 1));
  return `$${usd.toFixed(digits)}`;
}

/** Tokens x list price, in nanos. A price per million tokens is 1000 nanos per token per USD. */
export function costNanos(tokens: TokenUsage, price: TierPrice): number {
  return Math.round(
    tokens.uncachedInput * price.inputUsdPerMTok * 1000 +
      (tokens.cacheWrite5m ?? 0) * price.inputUsdPerMTok * 1250 +
      (tokens.cacheWrite1h ?? 0) * price.inputUsdPerMTok * 2000 +
      tokens.cachedInput * price.cachedInputUsdPerMTok * 1000 +
      tokens.output * price.outputUsdPerMTok * 1000,
  );
}

/** The spend ceiling for one attempt: the size ceiling scaled by the tier's fraction. */
export function ceilingNanos(config: TallyConfig, size: TaskSize, tier: Tier): number {
  return usdToNanos(config.ceilings.bySizeUsd[size] * tier.ceilingFraction);
}

export function attemptId(runId: string, taskId: string, attempt: number): string {
  return `${runId}:${taskId}:${attempt}`;
}
