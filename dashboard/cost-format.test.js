import { expect, test } from 'vitest';
import { attemptAmounts, attemptReason } from './cost-format.js';
import { budgetProvenance, budgetPageUrl } from './budget-link.js';

test('crossed ceilings retain a visible difference and matching reason', () => {
  const row = { result: 'stopped', estimatedCostNanos: 15307560, ceilingNanos: 15000000,
    resultReason: 'ceiling crossed: $0.02 spent against $0.02 ceiling; work committed' };
  expect(attemptAmounts(row.estimatedCostNanos, row.ceilingNanos, true)).toEqual({ cost: '$0.0153', ceiling: '$0.0150' });
  expect(attemptReason(row)).toBe('ceiling crossed: $0.0153 spent against a $0.0150 ceiling; work committed');
  expect(attemptAmounts(15000001, 15000000, true)).toEqual({ cost: '$0.015000001', ceiling: '$0.015000000' });
});

test('close uncrossed amounts remain distinguishable; ordinary amounts stay compact', () => {
  expect(attemptAmounts(14990000, 15000000)).toEqual({ cost: '$0.01499', ceiling: '$0.01500' });
  expect(attemptAmounts(100000000, 200000000)).toEqual({ cost: '$0.10', ceiling: '$0.20' });
  expect(attemptAmounts(0, null)).toEqual({ cost: '$0.00', ceiling: null });
  expect(attemptReason({ result: 'failed', resultReason: 'Tests failed' })).toBe('Tests failed');
});

test('limit provenance and system of record are independent, with legacy fallbacks', () => {
  expect(budgetProvenance({ source: 'config', limitSource: 'cli', systemOfRecord: 'cfoai' }))
    .toEqual({ limit: 'command-line cap', record: 'cfo.ai' });
  expect(budgetProvenance({ source: 'cfoai', limitSource: 'cli', systemOfRecord: 'ledger' }))
    .toEqual({ limit: 'command-line cap', record: 'ledger' });
  expect(budgetProvenance({ source: 'config' })).toEqual({ limit: 'tally.yaml', record: 'ledger' });
  expect(budgetProvenance({ source: 'cfoai' })).toEqual({ limit: 'cfo.ai budget table', record: 'cfo.ai' });
  expect(budgetPageUrl({ cfoai: { pageUrl: 'javascript:alert(1)' } })).toBeNull();
});
