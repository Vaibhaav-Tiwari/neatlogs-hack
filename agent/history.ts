/**
 * History: what each tier has actually done on each task size, plus the
 * prior that stands in until there is enough of it.
 */
import { ceilingNanos } from '../schema/money.js';
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
export const DEFAULT_PRIOR_WEIGHT = 2;

/** Assumed pass rate of the cheapest and the strongest tier, before any history. */
const PRIOR_PASS_RATE: Record<TaskSize, readonly [cheapest: number, top: number]> = {
  small: [0.7, 0.95],
  medium: [0.45, 0.9],
  large: [0.2, 0.85],
};

/** Position of a tier in the config, from 0 (cheapest) to 1 (strongest). */
export function tierRank(config: TallyConfig, tierName: string): number {
  const index = config.tiers.findIndex((tier) => tier.name === tierName);
  if (index < 0) throw new Error(`Tier "${tierName}" is not in tally.yaml`);
  return config.tiers.length === 1 ? 1 : index / (config.tiers.length - 1);
}

/**
 * The assumption used when a (size, tier) pair has no history: the pass rate
 * rises with the tier's position, and an attempt costs its full ceiling.
 */
export function priorFor(config: TallyConfig, size: TaskSize, tierName: string): Prior {
  const rank = tierRank(config, tierName);
  const [cheapest, top] = PRIOR_PASS_RATE[size];
  const tier = config.tiers.find((candidate) => candidate.name === tierName)!;
  return {
    passRate: cheapest + (top - cheapest) * rank,
    avgCostNanos: ceilingNanos(config, size, tier),
  };
}

export function blend(observed: PriceStats | null, prior: Prior, priorWeight = DEFAULT_PRIOR_WEIGHT): Estimate {
  if (!observed || observed.attempts <= 0) return { ...prior, attempts: 0 };
  const total = observed.attempts + priorWeight;
  return {
    passRate: (observed.passRate * observed.attempts + prior.passRate * priorWeight) / total,
    avgCostNanos: Math.round((observed.avgCostNanos * observed.attempts + prior.avgCostNanos * priorWeight) / total),
    attempts: observed.attempts,
  };
}

/** Pass rate and average cost to plan with. Never fails: unreadable history means the prior. */
export async function estimateFor(
  config: TallyConfig,
  history: PriceHistoryPort | undefined,
  size: TaskSize,
  tierName: string,
  priorWeight = DEFAULT_PRIOR_WEIGHT,
): Promise<Estimate> {
  const prior = priorFor(config, size, tierName);
  let observed: PriceStats | null = null;
  try {
    observed = (await history?.lookup(size, tierName)) ?? null;
  } catch {
    observed = null;
  }
  return blend(observed, prior, priorWeight);
}

interface Cell {
  attempts: number;
  passes: number;
  totalCostNanos: number;
}

export interface PriceHistorySnapshot {
  version: 1;
  /** Keyed by `${size}:${tier}`. */
  cells: Record<string, Cell>;
}

function isCell(value: unknown): value is Cell {
  if (typeof value !== 'object' || value === null) return false;
  const cell = value as Record<string, unknown>;
  return [cell.attempts, cell.passes, cell.totalCostNanos].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

/**
 * Local history, kept in memory. The engine saves `snapshot()` wherever it
 * keeps run output and passes it back in on the next run.
 */
export class PriceHistory implements PriceHistoryPort, PriceHistoryWriterPort {
  private readonly cells = new Map<string, Cell>();

  constructor(snapshot?: PriceHistorySnapshot) {
    if (snapshot?.version !== 1 || typeof snapshot.cells !== 'object' || snapshot.cells === null) return;
    for (const [key, cell] of Object.entries(snapshot.cells)) {
      if (isCell(cell)) this.cells.set(key, { ...cell });
    }
  }

  async lookup(size: TaskSize, tier: string): Promise<PriceStats | null> {
    const cell = this.cells.get(`${size}:${tier}`);
    if (!cell || cell.attempts === 0) return null;
    return {
      attempts: cell.attempts,
      passRate: cell.passes / cell.attempts,
      avgCostNanos: Math.round(cell.totalCostNanos / cell.attempts),
    };
  }

  async record(outcome: AttemptOutcome): Promise<void> {
    // An errored attempt broke outside the model, so it says nothing about the tier.
    if (outcome.result === 'error') return;
    const key = `${outcome.size}:${outcome.tier}`;
    const cell = this.cells.get(key) ?? { attempts: 0, passes: 0, totalCostNanos: 0 };
    cell.attempts += 1;
    if (outcome.result === 'passed') cell.passes += 1;
    cell.totalCostNanos += outcome.costNanos;
    this.cells.set(key, cell);
  }

  snapshot(): PriceHistorySnapshot {
    return { version: 1, cells: Object.fromEntries([...this.cells].map(([key, cell]) => [key, { ...cell }])) };
  }
}
