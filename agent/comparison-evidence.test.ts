import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LedgerRow, RunState } from '../schema/types.js';
import { comparisonEvidence } from './comparison-evidence.js';

const run = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/run.json', import.meta.url), 'utf8')) as RunState;
const ledger = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/ledger.json', import.meta.url), 'utf8')) as LedgerRow[];
const baseCommit = 'a'.repeat(40), taskId = ledger[0]!.taskId;
const measurement = { taskId, title: 'Example task', issueLengthChars: 100, filesNamedCount: 2,
  estimate: { size: 'small', signals: { source: 'entire-graph', filesTouched: 2, dependents: 26,
    impact: { source: 'entire-graph', query: 'exact task text', totals: { nodes: 12 } } } } };
const plan = { baseCommit, measuredAt: '2026-10-12T09:30:00Z', measurements: [measurement] };
const impact = { source: 'entire-graph' as const, query: 'exact task text', nodes: [], edges: [],
  totals: { filesTouched: 2, dependents: 26, testsPresent: true, nodes: 12, edges: 0 }, truncated: false };
const input = { run: { ...run, baseCommit, mode: 'tally' as const, tasks: [{ ...run.tasks.find(task => task.taskId === taskId)!, impact }] }, ledger: [ledger[0]!], path: 'fake-run', pass: 'B' as const };

describe('comparison plan evidence', () => {
  it('separates linked zero-token startup retries while retaining every recorded cost', () => {
    const first = { ...ledger[0]!, result: 'error' as const, tokens: { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 }, estimatedCostNanos: 7 };
    const retry = { ...ledger[0]!, attemptId: `${first.attemptId}:startup-retry`, result: 'passed' as const, estimatedCostNanos: 123 };
    const result = comparisonEvidence(plan, [{ ...input, ledger: [first, retry] }]);
    expect(result.rows[0]?.B[0]).toMatchObject({ attempts: 1, startupRetries: 1, passed: true, errored: false, costNanos: 130 });
    expect(result.summaries[1]).toMatchObject({ attempts: 1, startupRetries: 1, successRate: 1 });
    expect(comparisonEvidence(plan, [{ ...input, ledger: [first] }]).rows[0]?.B[0]).toMatchObject({ attempts: 1, startupRetries: 0, errored: true });
    expect(comparisonEvidence(plan, [{ ...input, ledger: [{ ...first, tokens: { ...first.tokens, total: 1 } }, retry] }]).rows[0]?.B[0]).toMatchObject({ attempts: 2, startupRetries: 0 });
  });

  it('keeps both modes pending with measured signals but no paid results', () => {
    const result = comparisonEvidence(plan, []);
    expect(result.rows[0]).toMatchObject({ size: 'small', filesTouched: 2, dependents: 26, graphNodes: 12, A: [], B: [], C: [] });
    expect(result.observations).toEqual([]);
  });

  it('joins actual costs and verdicts by base and task, without using proposed cost', () => {
    const result = comparisonEvidence({ ...plan, plannedCostUsd: 999 }, [input, {
      ...input, pass: 'A', run: { ...input.run, runId: 'baseline-run', mode: 'baseline', repeat: 1 },
      ledger: [{ ...ledger[0]!, runId: 'baseline-run', estimatedCostNanos: 123 }],
    }]);
    expect(result.rows[0]?.B[0]?.costNanos).toBe(ledger[0]!.estimatedCostNanos);
    expect(result.rows[0]?.A[0]).toMatchObject({ costNanos: 123, passed: true, repeat: 1 });
    expect(result.observations[0]).toMatchObject({ issueLength: 100, graphNodes: 12, textSource: 'plan-query', signalSource: 'comparison-plan' });
  });

  it('rejects mismatched/missing bases and mismatched measured task text', () => {
    for (const baseCommit of [null, 'b'.repeat(40)]) {
      expect(comparisonEvidence(plan, [{ ...input, run: { ...input.run, baseCommit } }]).observations).toEqual([]);
    }
    const impact = { source: 'none' as const, query: 'different task', nodes: [], edges: [],
      totals: { filesTouched: 0, dependents: 0, testsPresent: false, nodes: 0, edges: 0 }, truncated: false };
    expect(comparisonEvidence(plan, [{ ...input, run: { ...input.run, tasks: [{ ...input.run.tasks[0]!, impact }] } }]).excluded[0]?.reason).toContain('text differs');
    expect(comparisonEvidence(plan, [{ ...input, run: { ...input.run, tasks: [{ ...input.run.tasks[0]!, impact: undefined }] } }]).observations).toEqual([]);
  });

  it('excludes dry/active runs and duplicates and retains skipped real tasks', () => {
    expect(comparisonEvidence(plan, [{ ...input, run: { ...input.run, dryRun: true } }, { ...input, run: { ...input.run, status: 'running' } }]).observations).toEqual([]);
    expect(comparisonEvidence(plan, [input, input]).observations).toHaveLength(1);
    const skipped = { ...input, ledger: [], run: { ...input.run, tasks: [{ ...input.run.tasks[0]!, status: 'skipped' as const }] } };
    expect(comparisonEvidence(plan, [skipped]).rows[0]?.B[0]).toMatchObject({ costNanos: 0, passed: false, skipped: true });
  });

  it('does not infer B/C from routing text and keeps C explicitly separate from B', () => {
    expect(comparisonEvidence(plan, [{ ...input, pass: undefined }]).observations).toEqual([]);
    const result = comparisonEvidence(plan, [input, { ...input, pass: 'C', run: { ...input.run, runId: 'v2-run' }, ledger: [{ ...ledger[0]!, runId: 'v2-run' }] }]);
    expect(result.rows[0]?.B).toHaveLength(1);
    expect(result.rows[0]?.C).toHaveLength(1);
    expect(result.summaries.find(summary => summary.pass === 'A')).toMatchObject({ meanCostUsd: null, successRate: null });
    expect(result.observations[1]?.comparisonPass).toBe('C');
  });

  it('keeps repository-search dependents and graph size unmeasured', () => {
    const repository = { ...measurement, estimate: { ...measurement.estimate, signals: { ...measurement.estimate.signals,
      source: 'code-search', dependents: 0, impact: { ...measurement.estimate.signals.impact, source: 'code-search' } } } };
    expect(comparisonEvidence({ ...plan, measurements: [repository] }, []).rows[0]).toMatchObject({ dependents: null, graphNodes: null });
  });

  it('rejects invalid signal counts and duplicate tasks', () => {
    expect(() => comparisonEvidence({ ...plan, baseCommit: 'short' }, [])).toThrow();
    expect(() => comparisonEvidence({ ...plan, measurements: [measurement, measurement] }, [])).toThrow(/duplicate/);
    expect(() => comparisonEvidence({ ...plan, measurements: [{ ...measurement, issueLengthChars: -1 }] }, [])).toThrow();
  });
});
