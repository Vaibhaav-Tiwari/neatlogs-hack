import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionSummary } from './decision-view.js';

test('the dashboard summarizes route, scope and Neatlogs evidence without rendering the full rationale', () => {
  const view = decisionSummary({
    size: 'small',
    impact: { totals: { filesTouched: 2 } },
  }, [{
    tier: 'cheap',
    size: 'small',
    ceilingNanos: 300_000_000,
    decision: 'History for cheap uses neatlogs: 4 observations, 75% pass rate and $0.0104 average cost; small task starts on cheap capped at $0.30, expected to cost $0.6750 against $1.50 for going straight to top; cheap neatlogs: 4 observations, 75% pass rate and $0.0104 average cost.',
  }]);

  assert.equal(view.headline, 'Small scope · 2 target files · cheap tier · $0.30 cap · expected $0.68 vs $1.50 at top');
  assert.equal(view.history, 'Neatlogs · 4 similar attempts · 75% passed · $0.01 avg');
  assert.doesNotMatch(view.headline, /unknown-model|observations|;|config cap/);
});

test('the dashboard summarizes a skipped task without implying that a model ran', () => {
  assert.deepEqual(decisionSummary({ status: 'skipped' }, []), {
    headline: 'Skipped · budget did not cover the minimum attempt ceiling.',
    history: null,
  });
});
