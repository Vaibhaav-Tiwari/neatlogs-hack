import { describe, expect, it } from 'vitest';
import { frameAt } from './replay-core.js';
import { displayedCost, withLiveCosts } from './live-state.js';

describe('saved real run replay costs', () => {
  const start = '2026-10-10T18:00:00Z';
  const end = '2026-10-10T18:01:00Z';
  const ledger = [60_000_000, 90_000_000, 75_000_000, 26_700_000].map((cost, i) => ({
    taskId: `R${i}`, estimatedCostNanos: cost, ceilingNanos: 180_000_000,
    costSource: 'list-price', result: 'passed', startedAt: start, endedAt: end,
    tokens: { uncachedInput: 1000, cachedInput: 0, output: 100, total: 1100 },
  }));
  const total = ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0);
  const run = { startedAt: start, endedAt: end, status: 'finished', budget: { spentNanos: total }, tasks: ledger.map(row => ({ taskId: row.taskId, status: 'passed', spentNanos: row.estimatedCostNanos })) };

  it('uses only frame costs despite old timestamps and high ceilings, monotonically to the saved total', () => {
    let previous = 0;
    for (let step = 0; step <= 100; step++) {
      const frame = frameAt(run, ledger, step / 100);
      const display = withLiveCosts(frame, { replay: true, nowMs: Date.now() + 1e9 });
      const spend = display.ledger.reduce((sum, row) => sum + displayedCost(row), 0);
      expect(spend).toBe(frame.run.budget.spentNanos);
      expect(spend).toBeGreaterThanOrEqual(previous);
      expect(spend).toBeLessThanOrEqual(total);
      expect(display.ledger.every(row => row.displayIsReplay && !row.displayIsLiveEstimate)).toBe(true);
      previous = spend;
    }
    expect(previous).toBe(251_700_000);
  });

  it('still supplies ceiling-based live estimates outside replay mode', () => {
    const frame = frameAt(run, ledger, 0.5);
    const display = withLiveCosts(frame, { nowMs: Date.now() + 1e9 });
    expect(display.ledger.some(row => row.displayIsLiveEstimate)).toBe(true);
    expect(display.run.budget.spentNanos).toBeGreaterThan(frame.run.budget.spentNanos);
  });
});
