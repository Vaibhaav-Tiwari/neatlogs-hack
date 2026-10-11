/**
 * Ceiling watcher: decides when a running attempt has spent its ceiling and
 * must be stopped.
 */
import { costNanos } from '../schema/money.js';
import type { CostSource, Tier, TokenUsage } from '../schema/types.js';
import type { LiveUsage, LiveUsagePort, SessionControlPort, TracePort } from './ports.js';
import { usd } from './router.js';
import { traceDecision } from './trace.js';

export interface WatchedAttempt {
  sessionId: string;
  /** The tier running the attempt; its list price turns tokens into cost. */
  tier: Tier;
  /** Null means no ceiling (baseline mode); the attempt is never stopped. */
  ceilingNanos: number | null;
}

export interface CeilingCheck {
  costNanos: number;
  costSource: CostSource;
  tokens: TokenUsage | null;
  crossed: boolean;
}

export interface WatchVerdict extends CeilingCheck {
  action: 'continue' | 'stop';
  /** Ledger `resultReason` for a stopped attempt; null while the attempt may continue. */
  reason: string | null;
  /** False when a stop was needed but the session could not be stopped. */
  stopped: boolean;
  /** False when the usage could not be read on this poll, so the cost is unknown. */
  usageReadable: boolean;
}

export interface WatchOptions {
  intervalMs?: number;
  /** Abort when the attempt ends on its own. */
  signal?: AbortSignal;
  /** Replaceable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Cost is tokens x list price. The orchestrator's estimate is used only when the tier has no price. */
export function checkCeiling(usage: LiveUsage | null, attempt: WatchedAttempt): CeilingCheck {
  if (!usage) return { costNanos: 0, costSource: 'list-price', tokens: null, crossed: false };
  const listCost = costNanos(usage.tokens, attempt.tier.price);
  const priced = listCost > 0 || usage.estimatedCostNanos <= 0;
  const cost = priced ? listCost : usage.estimatedCostNanos;
  return {
    costNanos: cost,
    costSource: priced ? 'list-price' : 'ao-estimate',
    tokens: usage.tokens,
    crossed: attempt.ceilingNanos !== null && cost >= attempt.ceilingNanos,
  };
}

export class CeilingWatcher {
  constructor(private readonly ports: { usage: LiveUsagePort; sessions: SessionControlPort; trace?: TracePort }) {}

  /** Reads usage once and stops the session if it has crossed its ceiling. */
  async poll(attempt: WatchedAttempt): Promise<WatchVerdict> {
    return traceDecision(
      this.ports.trace,
      'tally.ceiling.poll',
      { sessionId: attempt.sessionId, tier: attempt.tier.name, ceilingNanos: attempt.ceilingNanos },
      async (span) => {
        let usage: LiveUsage | null;
        try {
          usage = await this.ports.usage.usageFor(attempt.sessionId);
        } catch {
          const verdict = { ...checkCeiling(null, attempt), action: 'continue' as const, reason: null, stopped: false, usageReadable: false };
          span.set({ action: verdict.action, costNanos: verdict.costNanos, crossed: verdict.crossed, usageReadable: false });
          return verdict;
        }
        const check = checkCeiling(usage, attempt);
        if (!check.crossed || attempt.ceilingNanos === null) {
          const verdict = { ...check, action: 'continue' as const, reason: null, stopped: false, usageReadable: true };
          span.set({ action: verdict.action, costNanos: verdict.costNanos, crossed: verdict.crossed, usageReadable: true });
          return verdict;
        }
        const reason = `ceiling crossed: ${usd(check.costNanos)} spent against a ${usd(attempt.ceilingNanos)} ceiling`;
        let stopped = true;
        try {
          await this.ports.sessions.stop(attempt.sessionId, reason);
        } catch {
          stopped = false;
        }
        const verdict = { ...check, action: 'stop' as const, reason, stopped, usageReadable: true };
        span.set({ action: verdict.action, costNanos: verdict.costNanos, crossed: verdict.crossed, stopped, reason });
        return verdict;
      },
    );
  }

  /** Polls until the session has been stopped at its ceiling or the signal is aborted. */
  async watch(attempt: WatchedAttempt, options: WatchOptions = {}): Promise<WatchVerdict> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      options.signal?.addEventListener('abort', done, { once: true });
      if (options.signal?.aborted) done();
    }));
    for (;;) {
      const verdict = await this.poll(attempt);
      if (verdict.action === 'stop' && verdict.stopped) return verdict;
      if (options.signal?.aborted) return verdict;
      await sleep(options.intervalMs ?? 5000);
      if (options.signal?.aborted) return verdict;
    }
  }
}
