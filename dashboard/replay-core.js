// Turns a finished run into the state it would have had part-way through.
// Shared by the page (?replay=60) and by replay.mjs, so it uses no browser
// or Node APIs.

const ms = (iso) => new Date(iso).getTime();

/** Start and end of the run in epoch milliseconds, taken from the ledger when the run has no end. */
export function runWindow(run, ledger) {
  const start = ms(run.startedAt);
  const ends = ledger.map((row) => (row.endedAt ? ms(row.endedAt) : 0));
  const end = Math.max(run.endedAt ? ms(run.endedAt) : 0, ...ends, start + Math.max(ledger.length, 1) * 1000);
  return { start, end };
}

function rowWindow(row, index, runStart, runEnd, count) {
  const began = ms(row.startedAt);
  const ended = row.endedAt ? ms(row.endedAt) : runEnd;
  if (ended > began) return { began, ended };

  // Dry-run attempts can be written with identical start/end timestamps because
  // the engine simulates work instantly. Spread those zero-duration rows across
  // the replay window so the dashboard still tells the story over ~60 seconds.
  const slice = Math.max(1, (runEnd - runStart) / Math.max(count, 1));
  return {
    began: runStart + index * slice,
    ended: runStart + (index + 1) * slice,
  };
}

function inFlight(row, share) {
  const scale = (n) => Math.round(n * share);
  const tokens = {
    uncachedInput: scale(row.tokens.uncachedInput),
    cachedInput: scale(row.tokens.cachedInput),
    output: scale(row.tokens.output),
  };
  tokens.total = tokens.uncachedInput + tokens.cachedInput + tokens.output;
  return {
    ...row,
    tokens,
    estimatedCostNanos: scale(row.estimatedCostNanos),
    result: 'running',
    resultReason: null,
    prUrl: null,
    checkpointId: null,
    checkpointUrl: null,
    endedAt: null,
  };
}

/**
 * The run and ledger as they stood `fraction` of the way through (0 to 1).
 * At 1 the inputs are returned untouched.
 */
export function frameAt(run, ledger, fraction) {
  if (fraction >= 1) return { run, ledger };
  const { start, end } = runWindow(run, ledger);
  const now = start + Math.max(0, fraction) * (end - start);

  const rows = [];
  for (const [index, row] of ledger.entries()) {
    const { began, ended } = rowWindow(row, index, start, end, ledger.length);
    if (began > now) continue;
    rows.push(ended <= now ? row : inFlight(row, (now - began) / Math.max(1, ended - began)));
  }

  const tasks = run.tasks.map((task) => {
    const all = ledger.filter((row) => row.taskId === task.taskId);
    const seen = rows.filter((row) => row.taskId === task.taskId);
    const last = seen[seen.length - 1];
    if (!last) {
      return {
        ...task,
        status: 'pending',
        statusReason: null,
        attempts: 0,
        tier: null,
        model: null,
        spentNanos: 0,
        escalated: false,
        prUrl: null,
        changedFiles: undefined,
      };
    }
    const settled = last.result !== 'running' && seen.length === all.length;
    return {
      ...task,
      status: settled ? task.status : 'running',
      statusReason: settled ? task.statusReason : null,
      attempts: seen.length,
      tier: last.tier,
      model: last.model,
      spentNanos: seen.reduce((sum, row) => sum + row.estimatedCostNanos, 0),
      escalated: seen.length > 1,
      prUrl: settled ? task.prUrl : null,
      changedFiles: settled ? task.changedFiles : undefined,
    };
  });

  return {
    run: {
      ...run,
      status: 'running',
      updatedAt: new Date(now).toISOString(),
      endedAt: null,
      budget: { ...run.budget, spentNanos: rows.reduce((sum, row) => sum + row.estimatedCostNanos, 0) },
      tasks,
    },
    ledger: rows,
  };
}
