import type { LedgerRow, RunMode, RunState, TaskSize } from '../schema/types.js';
import { taskEvidence, type TaskEvidence } from './evidence.js';

interface PlanMeasurement {
  taskId: string;
  title: string;
  size: TaskSize;
  filesTouched: number;
  dependents: number | null;
  graphNodes: number | null;
  issueLength: number;
  filesNamed: number;
  query: string | null;
}

export interface ComparisonOutcome {
  runId: string;
  mode: RunMode;
  repeat: number | null;
  costNanos: number;
  passed: boolean;
  errored: boolean;
  skipped: boolean;
  attempts: number;
  startupRetries: number;
  source: string;
}

export type ComparisonPass = 'A' | 'B' | 'C';
export interface ComparisonRun { run: RunState; ledger: LedgerRow[]; path: string; pass?: ComparisonPass }

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid comparison ${label}`);
  return value;
}

/** Joins measured plan signals, never planned spend, to validated real ledgers at the same base. */
export function comparisonEvidence(input: unknown, runs: ComparisonRun[]) {
  const plan = object(input);
  if (typeof plan.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(plan.baseCommit) || !Array.isArray(plan.measurements)) {
    throw new Error('Comparison plan needs a full baseCommit SHA and measurements array');
  }
  const ids = new Set<string>();
  const measurements: PlanMeasurement[] = plan.measurements.map(raw => {
    const item = object(raw), estimate = object(item.estimate), signals = object(estimate.signals);
    const impact = object(signals.impact), totals = object(impact.totals);
    if (typeof item.taskId !== 'string' || !item.taskId || ids.has(item.taskId)) throw new Error('Invalid or duplicate comparison taskId');
    ids.add(item.taskId);
    if (!['small', 'medium', 'large'].includes(String(estimate.size))) throw new Error('Invalid comparison task size');
    if (typeof impact.query !== 'string' || !impact.query.trim()) throw new Error('Comparison plan needs the measured task query');
    return {
      taskId: item.taskId, title: typeof item.title === 'string' ? item.title : item.taskId, size: estimate.size as TaskSize,
      filesTouched: count(signals.filesTouched, 'filesTouched'),
      dependents: signals.source === 'entire-graph' ? count(signals.dependents, 'dependents') : null,
      graphNodes: impact.source === 'entire-graph' ? count(totals.nodes, 'graph nodes') : null,
      issueLength: count(item.issueLengthChars, 'issueLengthChars'), filesNamed: count(item.filesNamedCount, 'filesNamedCount'),
      query: typeof impact.query === 'string' ? impact.query : null,
    };
  });
  const rows = measurements.map(item => ({ ...item, A: [] as ComparisonOutcome[], B: [] as ComparisonOutcome[], C: [] as ComparisonOutcome[] }));
  const observations: TaskEvidence[] = [], excluded: Array<{ runId: string; taskId: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const { run, ledger, path, pass } of runs) {
    if (run.dryRun !== false || run.status === 'running' || seen.has(run.runId)) continue;
    seen.add(run.runId);
    const evidence = taskEvidence(run, ledger, path);
    for (const row of rows) {
      const task = run.tasks.find(task => task.taskId === row.taskId);
      if (!task) continue;
      const reason = !pass ? 'comparison pass not explicitly labelled A/B/C'
        : (pass === 'A') !== (run.mode === 'baseline') ? 'run mode differs from labelled comparison pass'
        : run.baseCommit !== plan.baseCommit ? 'base SHA differs or is missing'
        : row.query && task.impact?.query !== row.query ? 'task text differs from the measured plan or is missing' : null;
      if (reason) { excluded.push({ runId: run.runId, taskId: row.taskId, reason }); continue; }
      const outcome = evidence.find(task => task.taskId === row.taskId);
      if (!outcome) continue;
      row[pass!].push({ runId: run.runId, mode: run.mode, repeat: run.repeat ?? null,
        costNanos: outcome.costNanos, passed: outcome.passed, errored: outcome.errored, skipped: outcome.skipped, attempts: outcome.attempts, startupRetries: outcome.startupRetries, source: path });
      observations.push({ ...outcome, size: row.size, filesTouched: row.filesTouched, graphNodes: row.graphNodes,
        issueLength: row.issueLength, filesNamed: row.filesNamed, textSource: 'plan-query', signalSource: 'comparison-plan', comparisonPass: pass });
    }
  }
  const summaries = (['A', 'B', 'C'] as const).map(pass => {
    const outcomes = rows.flatMap(row => row[pass]);
    return { pass, outcomes: outcomes.length, coveredTasks: rows.filter(row => row[pass].length).length, plannedTasks: rows.length,
      attempts: outcomes.reduce((sum, row) => sum + row.attempts, 0), passed: outcomes.filter(row => row.passed).length,
      startupRetries: outcomes.reduce((sum, row) => sum + row.startupRetries, 0),
      meanCostUsd: outcomes.length ? outcomes.reduce((sum, row) => sum + row.costNanos, 0) / outcomes.length / 1e9 : null,
      successRate: outcomes.length ? outcomes.filter(row => row.passed).length / outcomes.length : null };
  });
  return { baseCommit: plan.baseCommit, measuredAt: typeof plan.measuredAt === 'string' ? plan.measuredAt : null, rows, observations, summaries, excluded };
}
