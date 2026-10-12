export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

export async function runPool<T>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]!, index);
    }
  }));
}

import { ceilingNanos } from '../schema/money.js';
import type { TallyConfig, TaskSize, Tier } from '../schema/types.js';

/** Funds admission holds for an attempt and its possible immediate escalation. */
export function reservationNanos(config: TallyConfig, size: TaskSize, tier: Tier, attemptCeilingNanos: number | null = ceilingNanos(config, size, tier), attempt = 1): number {
  const next = attempt === 1 ? config.tiers[config.tiers.findIndex(candidate => candidate.name === tier.name) + 1] : undefined;
  const fallback = attempt === 1 && config.modelAccessFallbackTier
    ? config.tiers.find(candidate => candidate.name === config.modelAccessFallbackTier)
    : undefined;
  const retryCeiling = [next, fallback]
    .filter((candidate): candidate is Tier => Boolean(candidate))
    .reduce((maximum, candidate) => Math.max(maximum, ceilingNanos(config, size, candidate)), 0);
  return (attemptCeilingNanos ?? Infinity) + retryCeiling;
}

/** Reservations and ledger costs are exchanged synchronously, never across an await. */
export class Reservations {
  private held = new Map<string, number>();
  private waiters: Array<() => void> = [];

  constructor(private readonly available: () => number) {}

  remaining(owner?: string): number {
    return this.available() - [...this.held].reduce((sum, [key, amount]) => sum + (key === owner ? 0 : amount), 0);
  }

  reserve(owner: string, amount: number): boolean {
    if (amount > this.remaining(owner)) return false;
    this.held.set(owner, amount);
    return true;
  }

  settle(owner: string, cost: number): void {
    if (this.held.has(owner)) this.held.set(owner, Math.max(0, this.held.get(owner)! - cost));
    this.notify();
  }

  release(owner: string): void {
    this.held.delete(owner);
    this.notify();
  }

  waiting(owner?: string): Promise<void> | null {
    if (![...this.held.keys()].some(key => key !== owner)) return null;
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private notify(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
