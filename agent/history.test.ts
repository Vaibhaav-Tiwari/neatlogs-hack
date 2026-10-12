import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import { PriceHistory, blend, estimateFor, priorFor } from './history.js';
import { FakeHistory, sampleConfig } from './testing/fakes.js';

const config = sampleConfig();

describe('priorFor', () => {
  it('expects stronger tiers to pass more often', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const [bronze, silver, gold] = ['bronze', 'silver', 'gold'].map((tier) => priorFor(config, size, tier).passRate);
      expect(bronze!).toBeLessThan(silver!);
      expect(silver!).toBeLessThan(gold!);
    }
  });

  it('expects larger tasks to pass less often on the same tier', () => {
    expect(priorFor(config, 'large', 'bronze').passRate).toBeLessThan(priorFor(config, 'small', 'bronze').passRate);
  });

  it('assumes an attempt costs its ceiling until shown otherwise', () => {
    expect(priorFor(config, 'medium', 'gold').avgCostNanos).toBe(usdToNanos(4));
    expect(priorFor(config, 'medium', 'bronze').avgCostNanos).toBe(usdToNanos(0.8));
  });

  it('treats a single configured tier as the top tier', () => {
    const one = sampleConfig({ tiers: [config.tiers[0]!] });
    expect(priorFor(one, 'small', 'bronze').passRate).toBe(priorFor(config, 'small', 'gold').passRate);
  });

  it('rejects a tier that is not in the config', () => {
    expect(() => priorFor(config, 'small', 'platinum')).toThrow(/platinum/);
  });
});

describe('blend', () => {
  const prior = { passRate: 0.7, avgCostNanos: 300 };

  it('returns the prior when nothing has been observed', () => {
    expect(blend(null, prior)).toEqual({ ...prior, attempts: 0 });
    expect(blend({ attempts: 0, passRate: 0, avgCostNanos: 0 }, prior)).toEqual({ ...prior, attempts: 0 });
  });

  it('counts the prior as two attempts', () => {
    const estimate = blend({ attempts: 2, passRate: 0, avgCostNanos: 100 }, prior);
    expect(estimate.passRate).toBeCloseTo(0.35);
    expect(estimate.avgCostNanos).toBe(200);
    expect(estimate.attempts).toBe(2);
  });

  it('is dominated by the observations once there are many', () => {
    expect(blend({ attempts: 1000, passRate: 0.1, avgCostNanos: 100 }, prior).passRate).toBeCloseTo(0.1, 2);
  });
});

describe('estimateFor', () => {
  it('falls back to the prior when the history cannot be read', async () => {
    const history = new FakeHistory();
    history.failWith = new Error('neatlogs unreachable');
    const estimate = await estimateFor(config, history, 'small', 'bronze');
    expect(estimate).toEqual({ ...priorFor(config, 'small', 'bronze'), attempts: 0 });
  });

  it('works with no history port at all', async () => {
    expect((await estimateFor(config, undefined, 'small', 'gold')).attempts).toBe(0);
  });
});

describe('PriceHistory', () => {
  it('has nothing to report before the first attempt', async () => {
    expect(await new PriceHistory().lookup('small', 'bronze')).toBeNull();
  });

  it('updates pass rate and average cost after every attempt', async () => {
    const history = new PriceHistory();
    await history.record({ size: 'small', tier: 'bronze', result: 'passed', costNanos: 100 });
    expect(await history.lookup('small', 'bronze')).toEqual({ attempts: 1, passRate: 1, avgCostNanos: 100, successfulCostsNanos: [100] });
    await history.record({ size: 'small', tier: 'bronze', result: 'failed', costNanos: 300 });
    expect(await history.lookup('small', 'bronze')).toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: 200, successfulCostsNanos: [100] });
    await history.record({ size: 'small', tier: 'bronze', result: 'stopped', costNanos: 500 });
    expect(await history.lookup('small', 'bronze')).toEqual({ attempts: 3, passRate: 1 / 3, avgCostNanos: 300, successfulCostsNanos: [100] });
  });

  it('keeps each size and tier apart', async () => {
    const history = new PriceHistory();
    await history.record({ size: 'small', tier: 'bronze', result: 'passed', costNanos: 100 });
    expect(await history.lookup('medium', 'bronze')).toBeNull();
    expect(await history.lookup('small', 'silver')).toBeNull();
  });

  it('ignores attempts that errored, since they say nothing about the model', async () => {
    const history = new PriceHistory();
    await history.record({ size: 'small', tier: 'bronze', result: 'error', costNanos: 100 });
    expect(await history.lookup('small', 'bronze')).toBeNull();
  });

  it('survives a round trip through JSON', async () => {
    const history = new PriceHistory();
    await history.record({ size: 'large', tier: 'gold', result: 'passed', costNanos: 700 });
    const restored = new PriceHistory(JSON.parse(JSON.stringify(history.snapshot())));
    expect(await restored.lookup('large', 'gold')).toEqual({ attempts: 1, passRate: 1, avgCostNanos: 700, successfulCostsNanos: [700] });
  });

  it('starts empty from a snapshot it cannot read', async () => {
    const restored = new PriceHistory({ version: 99, cells: 'nope' } as never);
    expect(await restored.lookup('large', 'gold')).toBeNull();
  });

  it('feeds the estimate', async () => {
    const history = new PriceHistory();
    for (let i = 0; i < 8; i += 1) {
      await history.record({ size: 'small', tier: 'bronze', result: 'failed', costNanos: usdToNanos(0.3) });
    }
    const estimate = await estimateFor(config, history, 'small', 'bronze');
    expect(estimate.passRate).toBeCloseTo((0.7 * 2) / 10);
    expect(estimate.attempts).toBe(8);
  });
});
