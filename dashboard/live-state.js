export const isRunning = (row) => row.result === 'running' || !row.endedAt;

export const displayedCost = (row) => row.displayCostNanos ?? row.estimatedCostNanos ?? 0;

function liveCost(row, nowMs, liveCeilingSec) {
  if (!isRunning(row) || !row.ceilingNanos) return row.estimatedCostNanos ?? 0;
  const started = new Date(row.startedAt).getTime();
  if (!Number.isFinite(started)) return row.estimatedCostNanos ?? 0;
  const elapsed = Math.max(0, nowMs - started);
  const windowMs = Math.max(30_000, Number(liveCeilingSec ?? 180) * 1000);
  const towardCeiling = Math.round(row.ceilingNanos * Math.min(elapsed / windowMs, 0.98));
  return Math.max(row.estimatedCostNanos ?? 0, Math.min(row.ceilingNanos, towardCeiling));
}

export function withLiveCosts(state, options = {}) {
  if (state.run.status !== 'running') return state;
  const nowMs = options.nowMs ?? Date.now();
  const liveCeilingSec = options.liveCeilingSec ?? 180;
  const ledger = state.ledger.map((row) => {
    if (!isRunning(row)) return row;
    const displayCostNanos = liveCost(row, nowMs, liveCeilingSec);
    return { ...row, displayCostNanos, displayIsLiveEstimate: displayCostNanos !== row.estimatedCostNanos };
  });
  const tasks = state.run.tasks.map((task) => {
    const attempts = ledger.filter((row) => row.taskId === task.taskId).sort((a, b) => a.attempt - b.attempt);
    const last = attempts[attempts.length - 1];
    const hasRunning = attempts.some(isRunning);
    const spentNanos = attempts.reduce((sum, row) => sum + displayedCost(row), 0);
    return {
      ...task,
      status: hasRunning ? 'running' : task.status,
      statusReason: hasRunning ? null : task.statusReason,
      attempts: hasRunning ? attempts.length : task.attempts,
      tier: last?.tier ?? task.tier,
      model: last?.model ?? task.model,
      spentNanos,
      escalated: attempts.length > 1 || task.escalated,
      prUrl: hasRunning ? null : task.prUrl,
    };
  });
  const spentNanos = ledger.reduce((sum, row) => sum + displayedCost(row), 0);
  return {
    ...state,
    run: {
      ...state.run,
      updatedAt: new Date(nowMs).toISOString(),
      budget: { ...state.run.budget, spentNanos },
      tasks,
    },
    ledger,
  };
}
