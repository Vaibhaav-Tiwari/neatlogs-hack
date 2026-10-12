import { ceilingNanos } from '../schema/money.js';
import type { TallyConfig, TaskSize } from '../schema/types.js';
import type { PriceHistoryPort, PriceHistorySource } from './ports.js';
import { priorFor } from './history.js';

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
export async function planFromHistory(
  config: TallyConfig,
  history: PriceHistoryPort | undefined,
  size: TaskSize,
  tierName: string,
  minHistoryAttempts = 2,
): Promise<HistoryPlan> {
  const tier = config.tiers.find((item) => item.name === tierName);
  if (!tier) throw new Error(`Unknown tier ${tierName}`);
  const prior = priorFor(config, size, tierName);
  let observed = null;
  try { observed = await history?.lookup(size, tierName, tier.model) ?? null; } catch { /* Unavailable history uses config and prior. */ }
  if (observed && (!Number.isSafeInteger(observed.attempts) || observed.attempts < 1
    || !Number.isFinite(observed.passRate) || observed.passRate < 0 || observed.passRate > 1
    || !Number.isSafeInteger(observed.avgCostNanos) || observed.avgCostNanos < 0)) observed = null;
  const source = observed ? observed.source ?? history?.sourceOfLastLookup?.() ?? 'unknown' : 'none';
  const usedPrior = !observed || observed.attempts < minHistoryAttempts;
  const costs = (observed?.successfulCostsNanos ?? [])
    .filter((cost) => Number.isSafeInteger(cost) && cost > 0).sort((a, b) => a - b);
  const p90 = !usedPrior && costs.length >= 5 ? costs[Math.ceil(costs.length * 0.9) - 1]! : null;
  const configuredCeilingNanos = ceilingNanos(config, size, tier);
  return {
    tier: tierName, model: tier.model, size, attempts: observed?.attempts ?? 0, source, usedPrior,
    passRate: usedPrior ? prior.passRate : observed!.passRate,
    avgCostNanos: usedPrior ? prior.avgCostNanos : observed!.avgCostNanos,
    observedPassRate: observed?.passRate ?? null,
    observedAvgCostNanos: observed?.avgCostNanos ?? null,
    configuredCeilingNanos,
    ceilingNanos: p90 === null ? configuredCeilingNanos : Math.min(configuredCeilingNanos, Math.ceil(p90 * 1.5)),
    capSource: p90 === null ? 'config' : 'successful-p90',
    successfulSamples: costs.length, p90CostNanos: p90,
  };
}
