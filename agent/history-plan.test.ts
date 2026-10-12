import { describe, expect, it } from 'vitest';
import { planFromHistory } from './history-plan.js';
import { FakeHistory, sampleConfig } from './testing/fakes.js';

const config = sampleConfig();

describe('history-derived caps', () => {
  it('uses nearest-rank P90 of successful costs times 1.5 with explicit provenance', async () => {
    const history = new FakeHistory().set('small', 'bronze', {
      attempts: 10, passRate: 0.5, avgCostNanos: 60_000_000, source: 'neatlogs',
      successfulCostsNanos: [10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000],
    });
    expect(await planFromHistory(config, history, 'small', 'bronze')).toMatchObject({
      source: 'neatlogs', attempts: 10, passRate: 0.5, usedPrior: false,
      ceilingNanos: 75_000_000, p90CostNanos: 50_000_000, capSource: 'successful-p90',
    });
  });

  it('never exceeds the configured maximum', async () => {
    const history = new FakeHistory().set('small', 'bronze', {
      attempts: 5, passRate: 1, avgCostNanos: 1_000_000_000,
      successfulCostsNanos: Array(5).fill(1_000_000_000), source: 'local',
    });
    expect(await planFromHistory(config, history, 'small', 'bronze')).toMatchObject({ ceilingNanos: 300_000_000 });
  });

  it('keeps config with fewer than five successful costs, including migrated aggregate-only history', async () => {
    for (const successfulCostsNanos of [undefined, [10, 20, 30, 40], [0, -1, NaN, Infinity, 10]]) {
      const history = new FakeHistory().set('small', 'bronze', {
        attempts: 10, passRate: 0.4, avgCostNanos: 100, successfulCostsNanos,
      });
      expect(await planFromHistory(config, history, 'small', 'bronze')).toMatchObject({
        capSource: 'config', ceilingNanos: 300_000_000,
      });
    }
  });

  it('falls back safely for no history, invalid history and read errors', async () => {
    const invalid = new FakeHistory().set('small', 'bronze', { attempts: 5, passRate: NaN, avgCostNanos: 100 });
    const failing = new FakeHistory(); failing.failWith = new Error('offline');
    for (const history of [undefined, invalid, failing]) {
      expect(await planFromHistory(config, history, 'small', 'bronze')).toMatchObject({
        source: 'none', usedPrior: true, capSource: 'config', ceilingNanos: 300_000_000,
      });
    }
  });
});
