import type { LedgerRow, RunState } from '../schema/types.js';

export type RoutingCohort = 'prior-only' | 'trace-driven' | 'local-history' | 'unattributed' | 'baseline';
export interface TaskEvidence {
  runId: string;
  repo: string;
  taskId: string;
  cohort: RoutingCohort;
  decision: string | null;
  costNanos: number;
  passed: boolean;
  errored: boolean;
  skipped: boolean;
  attempts: number;
  size: string | null;
  graphNodes: number | null;
  filesTouched: number | null;
  issueLength: number | null;
  filesNamed: number | null;
  textSource: 'run-query' | 'current-issue' | 'plan-query' | 'missing';
  signalSource?: 'comparison-plan';
  comparisonPass?: 'A' | 'B' | 'C';
  models: string[];
  source: string;
}

export interface Correlation {
  n: number;
  pearson: number | null;
  spearman: number | null;
  interpretation: string;
}

function pearson(pairs: [number, number][]): number | null {
  if (pairs.length < 3) return null;
  const meanX = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const meanY = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
  let xx = 0, yy = 0, xy = 0;
  for (const [x, y] of pairs) { xx += (x - meanX) ** 2; yy += (y - meanY) ** 2; xy += (x - meanX) * (y - meanY); }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null;
}

function ranks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = new Map<number, number>();
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j] === sorted[i]) j++;
    rank.set(sorted[i]!, (i + j - 1) / 2 + 1); i = j;
  }
  return values.map(value => rank.get(value)!);
}

export function correlate(input: [number | null, number][]): Correlation {
  const pairs = input.filter((pair): pair is [number, number] => pair[0] !== null && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  const p = pearson(pairs);
  const xs = ranks(pairs.map(([x]) => x)), ys = ranks(pairs.map(([, y]) => y));
  const s = pearson(xs.map((x, i) => [x, ys[i]!]));
  return {
    n: pairs.length, pearson: p, spearman: s,
    interpretation: p === null ? 'No estimable signal: fewer than 3 pairs or no variation.'
      : Math.abs(p) < 0.3 ? 'No clear linear signal in this sample.'
      : `${p > 0 ? 'Positive' : 'Negative'} association in this sample, not a causal or out-of-sample prediction.`,
  };
}

function cohort(run: RunState, first?: LedgerRow): RoutingCohort {
  if (run.mode === 'baseline') return 'baseline';
  if (!first) return 'unattributed';
  const name = first.tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selected = first.decision.split(';').find(part => new RegExp(`^\\s*${name} (?:neatlogs|local): \\d+ observations`).test(part));
  if (selected?.includes('neatlogs:') && selected.includes('observed statistics')) return 'trace-driven';
  if (selected?.includes('local:') && selected.includes('observed statistics')) return 'local-history';
  if (first.decision.includes(`No usable history exists for ${first.tier} on ${first.size}`)
    || new RegExp(`History has only \\d+ ${name} attempts? for ${first.size}, so it uses the prior`).test(first.decision)) return 'prior-only';
  return 'unattributed';
}

/** Only closed real runs from an audited manifest; missing metrics remain missing. */
export function taskEvidence(run: RunState, ledger: LedgerRow[], source: string,
  issues: Record<string, { title: string; body: string }> = {}): TaskEvidence[] {
  if (run.dryRun !== false || run.status === 'running') return [];
  const real = ledger.filter(row => row.runId === run.runId && row.costSource !== 'simulated');
  const result: TaskEvidence[] = [];
  for (const task of run.tasks) {
    const rows = real.filter(row => row.taskId === task.taskId).sort((a, b) => a.attempt - b.attempt);
    const attempts = rows.filter(row => !row.attemptId.endsWith(':handoff'));
    const skipped = !attempts.length && (task.status === 'skipped' || run.status === 'interrupted');
    if (!attempts.length && !skipped) continue;
    const first = attempts[0], last = attempts.at(-1);
    const issue = task.issueUrl ? issues[task.issueUrl] : undefined;
    const query = task.impact?.query || (issue ? `${issue.title}\n${issue.body}` : null);
    const files = query?.match(/\b(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+\b/g);
    result.push({
      runId: run.runId, repo: run.repo, taskId: task.taskId, cohort: cohort(run, first), decision: first?.decision ?? null,
      costNanos: rows.reduce((sum, row) => sum + row.estimatedCostNanos, 0),
      passed: last?.result === 'passed', errored: last?.result === 'error', skipped, attempts: attempts.length,
      size: task.size, graphNodes: task.impact?.source === 'entire-graph' ? task.impact.totals.nodes : null,
      filesTouched: task.impact?.totals.filesTouched ?? null,
      issueLength: query?.length ?? null, filesNamed: query === null ? null : new Set(files ?? []).size,
      textSource: task.impact?.query ? 'run-query' : issue ? 'current-issue' : 'missing',
      models: [...new Set(attempts.map(row => row.model))], source,
    });
  }
  return result;
}

export function cohortSummary(tasks: TaskEvidence[], group: RoutingCohort) {
  const rows = tasks.filter(task => task.cohort === group);
  const spent = rows.reduce((sum, row) => sum + row.costNanos, 0);
  return { cohort: group, tasks: rows.length, passed: rows.filter(row => row.passed).length,
    errors: rows.filter(row => row.errored).length, skipped: rows.filter(row => row.skipped).length, totalCostUsd: spent / 1e9,
    meanCostUsd: rows.length ? spent / rows.length / 1e9 : null,
    successRate: rows.length ? rows.filter(row => row.passed).length / rows.length : null };
}
