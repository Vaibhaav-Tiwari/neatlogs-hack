import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerPort, WorkerStartInput } from './real.js';
import { runRealTally } from './real.js';
import { createDryRunPorts } from './dry-run.js';
import { loadConfig } from './config.js';
import { ExperimentWorker, EXPERIMENT_CAP_REASON, runExperiment, updateExperimentSummary } from './experiment.js';

const configPath = resolve('demo/tally.yaml');
const baseCommit = 'a'.repeat(40);
const now = () => new Date('2026-10-11T02:00:00Z');

describe('experiment', () => {
  it('runs both modes through the loop, rewrites progress after each run and preserves null comparisons', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'tally-experiment-'));
    const result = await runExperiment({ configPath, dryRun: true, repeats: 1, budgetUsd: 400, runsDir, now, baseCommit });
    expect(result.summary.status).toBe('finished');
    expect(result.summary.real).toBe(false);
    expect(result.summary.taskIds).toHaveLength(7);
    expect(result.summary.modes.baseline.runs).toHaveLength(1);
    expect(result.summary.modes.tally.runs).toHaveLength(1);
    expect(result.summary.modes.baseline.totalCostNanos.min).toBe(result.summary.modes.baseline.totalCostNanos.max);
    expect(result.summary.perTask.every((task) => task.baseline.length === 1 && task.tally.length === 1)).toBe(true);
    expect(JSON.parse(readFileSync(result.summaryPath, 'utf8'))).toEqual(result.summary);
    const baseline = result.summary.modes.baseline.runs[0]!;
    expect(JSON.parse(readFileSync(join(runsDir, baseline.runId, 'run.json'), 'utf8'))).toMatchObject({ mode: 'baseline', repeat: 1, dryRun: true, baseCommit });
    expect(result.summary.budget.spentNanos).toBe(baseline.totalCostNanos + result.summary.modes.tally.runs[0]!.totalCostNanos);
    const empty = structuredClone(result.summary);
    empty.modes.tally.runs = [];
    const runState = JSON.parse(readFileSync(join(runsDir, baseline.runId, 'run.json'), 'utf8'));
    runState.mode = 'tally';
    runState.tasks.forEach((task: { status: string }) => { task.status = 'failed'; });
    updateExperimentSummary(empty, { runState, ledger: [], outputDir: '', runStatePath: '', ledgerPath: '', latestRunDir: '' }, 2);
    expect(empty.modes.tally.runs[0]?.costPerPassedTaskNanos).toBeNull();
    expect(empty.comparison.costPerPassedTaskChangePct).toBeNull();
  }, 10_000);

  it.each([true, false])('stops at the aggregate cap without escalation; baseline=%s', async (baseline) => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-experiment-cap-'));
    const starts: WorkerStartInput[] = [];
    const stops: string[] = [];
    const worker: WorkerPort = { start: async (input) => { starts.push(input); return { sessionId: 'worker', branch: 'task', checkoutPath: '/fake' }; }, wait: () => new Promise(() => {}) };
    const usage = { usageFor: async () => ({ tokens: { uncachedInput: 1, cachedInput: 0, output: 0, total: 1 }, estimatedCostNanos: 0 }) };
    const guarded = new ExperimentWorker({ worker, usage, sessions: { stop: async (id) => { stops.push(id); } } }, 1, 0, 1);
    const result = await runRealTally({ configPath, dryRun: true, baseline, budgetUsd: 400, outputDir: join(dir, 'run'), latestRunDir: join(dir, 'latest'), now,
      stopRequested: () => guarded.stopReason(), ports: { ...createDryRunPorts({ config: loadConfig(configPath), configPath }), worker: guarded, usage: guarded, sessions: guarded,
        verifier: { verify: async () => { throw new Error('stopped attempt must not verify'); } } } });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.ceilingNanos).toBe(baseline ? null : 200_000_000);
    expect(starts[0]?.tier.name).toBe(baseline ? 'top' : 'cheap');
    expect(stops).toEqual(['worker']);
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ result: 'stopped', resultReason: EXPERIMENT_CAP_REASON, ceilingNanos: baseline ? 0 : 200_000_000 });
    expect(result.runState.status).toBe('interrupted');
    expect(result.runState.tasks.slice(1).every((task) => task.status === 'skipped')).toBe(true);
    await expect(guarded.start(starts[0]!)).rejects.toThrow(EXPERIMENT_CAP_REASON);
  }, 5000);

  it('writes stopped summary when the shared budget prevents further repeats', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'tally-experiment-small-'));
    const result = await runExperiment({ configPath, dryRun: true, repeats: 2, budgetUsd: 0.001, runsDir, now, baseCommit });
    expect(result.summary).toMatchObject({ status: 'stopped', reason: EXPERIMENT_CAP_REASON });
    expect(result.summary.modes.tally.runs).toEqual([]);
    expect(result.summary.comparison.totalCostChangePct).toBeNull();
  }, 5000);

  it('rewrites a running summary between modes and preserves a stopped partial run on exceptions', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'tally-experiment-progress-'));
    const summaryPath = join(runsDir, 'experiments', 'exp-20261011-020000Z', 'summary.json');
    const worker: WorkerPort = { start: async () => {
      expect(JSON.parse(readFileSync(summaryPath, 'utf8')).status).toBe('running');
      throw new Error('worker launch failed');
    }, wait: async () => { throw new Error('unexpected wait'); } };
    await expect(runExperiment({ configPath, dryRun: true, repeats: 1, budgetUsd: 400, runsDir, now, baseCommit, ports: { worker } })).rejects.toThrow('worker launch failed');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    expect(summary.status).toBe('stopped');
    expect(summary.reason).toBe('worker launch failed');
    expect(summary.modes.baseline.runs[0].status).toBe('interrupted');
    expect(summary.comparison.totalCostChangePct).toBeNull();
  });

  it('exposes the completed baseline in the running summary before starting Tally', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'tally-experiment-between-'));
    const summaryPath = join(runsDir, 'experiments', 'exp-20261011-020000Z', 'summary.json');
    const ports = createDryRunPorts({ config: loadConfig(configPath), configPath });
    const original = ports.worker!;
    let observed = false;
    ports.worker = { start: async (input) => {
      if (input.name.includes('-tally-1-')) {
        const progress = JSON.parse(readFileSync(summaryPath, 'utf8'));
        expect(progress.status).toBe('running');
        expect(progress.modes.baseline.runs).toHaveLength(1);
        expect(progress.comparison.totalCostChangePct).toBeNull();
        observed = true;
      }
      return original.start(input);
    }, wait: (id, options) => original.wait(id, options) };
    await runExperiment({ configPath, dryRun: true, repeats: 1, budgetUsd: 400, runsDir, now, baseCommit, ports });
    expect(observed).toBe(true);
  }, 5000);

  it('requires an explicit real budget before any worker is started', async () => {
    await expect(runExperiment({ configPath, dryRun: false })).rejects.toThrow('explicit --budget');
  });
});
