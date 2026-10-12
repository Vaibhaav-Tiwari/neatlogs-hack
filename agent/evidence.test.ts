import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LedgerRow, RunState } from '../schema/types.js';
import { cohortSummary, correlate, taskEvidence } from './evidence.js';

const run = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/run.json', import.meta.url), 'utf8')) as RunState;
const ledger = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/ledger.json', import.meta.url), 'utf8')) as LedgerRow[];

describe('real-run evidence', () => {
  it('excludes dry runs and unfinished runs', () => {
    expect(taskEvidence({ ...run, dryRun: true }, ledger, 'fake')).toEqual([]);
    expect(taskEvidence({ ...run, status: 'running' }, ledger, 'fake')).toEqual([]);
  });

  it('excludes simulated rows, sums attempts per task execution and does not invent missing signals', () => {
    const first = ledger[0]!;
    const input = [
      { ...first, result: 'stopped' as const, estimatedCostNanos: 10 },
      { ...first, attempt: 2, attemptId: `${first.attemptId}:2`, result: 'passed' as const, estimatedCostNanos: 20 },
      { ...first, attemptId: `${first.attemptId}:handoff`, estimatedCostNanos: 3 },
      { ...ledger[1]!, costSource: 'simulated' as const },
    ];
    const rows = taskEvidence(run, input, 'fake');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costNanos: 33, passed: true, attempts: 2, source: 'fake' });
  });

  it('does not label an ambiguous historical decision as trace-driven', () => {
    const first = ledger[0]!;
    const rows = taskEvidence(run, [{ ...first, decision: 'Small task goes cheap.' }], 'fake');
    expect(rows[0]?.cohort).toBe('unattributed');
  });

  it('requires selected-tier observed trace statistics, not another candidate or a learned-cap claim', () => {
    const first = ledger[0]!;
    const decision = `${first.tier} neatlogs: 5 observations, observed statistics, P90 $0.01 x 1.5; other local: 8 observations, observed statistics.`;
    expect(taskEvidence(run, [{ ...first, decision }], 'fake')[0]?.cohort).toBe('trace-driven');
    expect(taskEvidence(run, [{ ...first, decision: `other neatlogs: 5 observations, observed statistics, P90; ${first.tier} neatlogs: 3 observations, observed statistics, config cap` }], 'fake')[0]?.cohort).toBe('trace-driven');
    expect(taskEvidence(run, [{ ...first, decision: `other neatlogs: 5 observations, observed statistics, P90; ${first.tier} neatlogs: 1 observations, uses the prior, config cap` }], 'fake')[0]?.cohort).not.toBe('trace-driven');
  });

  it('uses missing rather than zero for an unmeasured comparison cohort', () => {
    expect(cohortSummary([], 'baseline')).toMatchObject({ tasks: 0, meanCostUsd: null, successRate: null });
  });

  it('retains skipped baseline tasks and interrupted attempts in the denominator', () => {
    const first = ledger[0]!;
    const task = run.tasks.find(task => task.taskId === first.taskId)!;
    const closed = { ...run, mode: 'baseline' as const, tasks: [task, { ...task, taskId: 'skipped-task', status: 'skipped' as const }] };
    const rows = taskEvidence(closed, [first], 'fake');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ skipped: true, passed: false, costNanos: 0, attempts: 0, cohort: 'baseline' });
    expect(cohortSummary(rows, 'baseline')).toMatchObject({ tasks: 2, passed: 1, skipped: 1, successRate: 0.5 });
    expect(taskEvidence({ ...closed, status: 'interrupted' }, [{ ...first, result: 'stopped' }], 'fake')[0]?.passed).toBe(false);
  });

  it('reports Pearson and tied-rank Spearman, not a prediction claim', () => {
    expect(correlate([[1, 2], [2, 4], [3, 6]])).toMatchObject({ n: 3, pearson: 1, spearman: 1 });
    expect(correlate([[1, 3], [2, 2], [3, 1]])).toMatchObject({ n: 3, pearson: -1, spearman: -1 });
    expect(correlate([[1, 1], [1, 2], [1, 3]])).toMatchObject({ pearson: null, spearman: null });
    expect(correlate([[1, 1], [null, 4]])).toMatchObject({ n: 1, pearson: null });
  });
});
