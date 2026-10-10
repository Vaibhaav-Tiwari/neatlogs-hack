import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import type { TaskSize } from '../schema/types.js';
import { routeTask, type RouteDecision } from './router.js';
import type { SizeEstimate } from './sizer.js';
import { FakeBudget, FakeHistory, sampleConfig, task } from './testing/fakes.js';

const config = sampleConfig();

function estimate(size: TaskSize, confidence: number): SizeEstimate {
  return {
    size,
    confidence,
    signals: { filesTouched: 1, dependents: 0, testsPresent: true, source: 'entire-graph' },
    specificity: 0.5,
    refinedBy: 'rules',
    summary: '1 file touched, no dependents and tests present',
  };
}

async function route(
  size: TaskSize,
  confidence: number,
  budgetUsd = 40,
  history = new FakeHistory(),
  cfg = config,
): Promise<RouteDecision> {
  return routeTask({
    task: task(),
    estimate: estimate(size, confidence),
    config: cfg,
    ports: { history, budget: new FakeBudget(usdToNanos(budgetUsd)) },
  });
}

function started(decision: RouteDecision) {
  if (decision.action !== 'start') throw new Error(`expected a start, got: ${decision.reason}`);
  return decision;
}

/** Enough observations that the prior no longer matters. */
const seen = (passRate: number, avgUsd: number) => ({ attempts: 1000, passRate, avgCostNanos: usdToNanos(avgUsd) });

function expectOneSentence(reason: string): void {
  expect(reason).toMatch(/^[A-Z].*\.$/);
  expect(reason).not.toMatch(/[.!?]\s/);
  expect(reason).not.toContain('\n');
}

describe('routeTask', () => {
  it('chooses the cheapest tier when the sizer is confident', async () => {
    const decision = started(await route('small', 0.9));
    expect(decision.tier.name).toBe('bronze');
    expect(decision.ceilingNanos).toBe(usdToNanos(0.3));
    expect(decision.reason).toContain('bronze');
    expect(decision.reason).toContain('$0.30');
  });

  it('caps the cheap attempt at 20% of what the top tier may spend', async () => {
    const decision = started(await route('medium', 0.9));
    expect(decision.tier.name).toBe('bronze');
    expect(decision.ceilingNanos).toBe(usdToNanos(4) * 0.2);
  });

  it('goes straight to the strongest tier when the sizer is unsure', async () => {
    const decision = started(await route('small', 0.2));
    expect(decision.tier.name).toBe('gold');
    expect(decision.ceilingNanos).toBe(usdToNanos(1.5));
    expect(decision.reason).toMatch(/uncertain/);
  });

  it('starts in the middle when it is sure enough for that but not for the cheapest', async () => {
    const decision = started(await route('medium', 0.5));
    expect(decision.tier.name).toBe('silver');
    expect(decision.reason).toMatch(/uncertain for bronze/);
  });

  it('applies the rule: ceiling + P(fail) x top cost must be below top cost', async () => {
    // Small: top cost 1.50, bronze ceiling 0.30. Break-even is a failure rate of 80%.
    const fails85 = new FakeHistory().set('small', 'bronze', seen(0.15, 0.3));
    expect(started(await route('small', 0.95, 40, fails85)).tier.name).not.toBe('bronze');

    const fails50 = new FakeHistory().set('small', 'bronze', seen(0.5, 0.3));
    const decision = started(await route('small', 0.95, 40, fails50));
    expect(decision.tier.name).toBe('bronze');
    // 0.30 + 0.5 x 1.50, give or take the prior's small pull.
    expect(decision.expectedCostNanos / 1e9).toBeCloseTo(1.05, 2);
    expect(decision.topCostNanos).toBe(usdToNanos(1.5));
  });

  it('stops sending a size to a tier that keeps failing it, however confident the sizer is', async () => {
    const history = new FakeHistory()
      .set('small', 'bronze', seen(0.05, 0.3))
      .set('small', 'silver', seen(0.05, 0.75));
    const decision = started(await route('small', 1, 40, history));
    expect(decision.tier.name).toBe('gold');
    expect(decision.reason).toMatch(/fail/);
  });

  it('never sends a large task to the cheapest tier on the prior alone', async () => {
    expect(started(await route('large', 1)).tier.name).not.toBe('bronze');
  });

  it('goes straight to the top when the top tier already costs less than a cheap ceiling', async () => {
    const history = new FakeHistory().set('small', 'gold', seen(0.95, 0.2));
    const decision = started(await route('small', 1, 40, history));
    expect(decision.tier.name).toBe('gold');
  });

  it('uses the prior when the history cannot be read', async () => {
    const history = new FakeHistory();
    history.failWith = new Error('unreachable');
    expect(started(await route('small', 0.9, 40, history)).tier.name).toBe('bronze');
  });

  describe('budget', () => {
    it('starts nothing when no ceiling fits the budget left', async () => {
      const decision = await route('small', 0.9, 0.1);
      expect(decision.action).toBe('skip');
      if (decision.action !== 'skip') return;
      expect(decision.statusReason).toBe('not started: no budget');
      expect(decision.reason).toContain('$0.10');
      expectOneSentence(decision.reason);
    });

    it('starts a task whose ceiling exactly fits', async () => {
      expect(started(await route('small', 0.9, 0.3)).tier.name).toBe('bronze');
    });

    it('falls back to a cheaper tier that fits when the preferred one does not', async () => {
      const decision = started(await route('small', 0.2, 0.5));
      expect(decision.tier.name).toBe('bronze');
      expect(decision.reason).toMatch(/budget/);
    });

    it('does not burn the last of the budget on an attempt that will probably fail', async () => {
      // Large: gold needs 10, silver 5, bronze 2. Only bronze fits, and it passes ~20% of the time.
      expect((await route('large', 0.2, 2.5)).action).toBe('skip');
    });

    it('never starts an attempt whose ceiling is above the budget left', async () => {
      for (const size of ['small', 'medium', 'large'] as const) {
        for (const confidence of [0, 0.3, 0.5, 0.8, 1]) {
          for (const budgetUsd of [0, 0.05, 0.3, 0.5, 0.8, 1, 2, 3.9, 5, 9.99, 10, 40]) {
            const decision = await route(size, confidence, budgetUsd);
            if (decision.action === 'start') expect(decision.ceilingNanos).toBeLessThanOrEqual(usdToNanos(budgetUsd));
          }
        }
      }
    });
  });

  describe('tiers come from the config', () => {
    it('works with a single tier', async () => {
      const one = sampleConfig({ tiers: [{ ...config.tiers[2]!, name: 'only' }] });
      const decision = started(await route('small', 0.9, 40, new FakeHistory(), one));
      expect(decision.tier.name).toBe('only');
      expectOneSentence(decision.reason);
    });

    it('works with two tiers and any names', async () => {
      const two = sampleConfig({
        tiers: [
          { ...config.tiers[0]!, name: 'intern' },
          { ...config.tiers[2]!, name: 'principal' },
        ],
      });
      expect(started(await route('small', 0.9, 40, new FakeHistory(), two)).tier.name).toBe('intern');
      expect(started(await route('small', 0.1, 40, new FakeHistory(), two)).tier.name).toBe('principal');
    });

    it('returns the whole tier, so the caller needs no model table of its own', async () => {
      const decision = started(await route('small', 0.9));
      expect(decision.tier).toBe(config.tiers[0]);
    });
  });

  it('gives a one-sentence reason for every decision', async () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const confidence of [0, 0.4, 0.6, 1]) {
        for (const budgetUsd of [0.1, 0.5, 2.5, 40]) {
          expectOneSentence((await route(size, confidence, budgetUsd)).reason);
        }
      }
    }
  });
});
