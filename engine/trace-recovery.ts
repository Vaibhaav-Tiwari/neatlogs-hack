import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NeatlogsWorkerSpoolAdapter, type WorkerTraceDrainPort } from '../adapters/neatlogs-worker-spool.js';
import { NeatlogsWorkerTraceReader, type WorkerTraceReaderPort } from '../adapters/neatlogs-worker-traces.js';
import { validateLedger, validateRunState, type Ledger, type RunState } from '../schema/index.js';

function replaceJson(path: string, value: unknown): void {
  writeFileSync(`${path}.trace-recovery.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.trace-recovery.tmp`, path);
}

export async function recoverRunTraces(options: {
  runId: string;
  outputDir?: string;
  drain?: WorkerTraceDrainPort;
  reader?: WorkerTraceReaderPort;
  now?: () => Date;
}): Promise<{ before: RunState['integrations']['neatlogs']; after: RunState['integrations']['neatlogs']; traceIds: string[] }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.runId)) throw new Error('Invalid run id');
  const outputDir = resolve(options.outputDir ?? join('.tally', 'runs', options.runId));
  const runPath = join(outputDir, 'run.json');
  const ledgerPath = join(outputDir, 'ledger.json');
  const originalRun = readFileSync(runPath, 'utf8');
  const originalLedger = readFileSync(ledgerPath, 'utf8');
  const run = JSON.parse(originalRun) as RunState;
  const ledger = JSON.parse(originalLedger) as Ledger;
  if (!validateRunState(run).ok || !validateLedger(ledger).ok) throw new Error('Invalid saved run or ledger');
  if (run.runId !== options.runId || ledger.some(r => r.runId !== run.runId)) throw new Error('Run id does not match saved evidence');
  if (run.status !== 'finished' || run.dryRun || run.integrations.neatlogs.status === 'off') throw new Error('Only finished real runs with neatlogs enabled can be recovered');
  const workers = ledger.filter(r => r.sessionId && r.costSource !== 'simulated' && r.harness !== 'entire');
  if (!workers.length || workers.some(r => !r.entireSessionId)) throw new Error('Native session evidence is required for every worker attempt');
  const drain = options.drain ?? new NeatlogsWorkerSpoolAdapter();
  const reader = options.reader ?? new NeatlogsWorkerTraceReader();
  const before = { ...run.integrations.neatlogs };
  const traceIds: string[] = [];
  for (const row of workers) {
    await drain.drainWorker({ checkoutPath: null, entireSessionId: row.entireSessionId });
    if (drain.status && drain.status().status !== 'ok') throw new Error('Worker batches remain pending; saved status was not changed');
    const id = await reader.verifyFor({ runId: row.runId, taskId: row.taskId, attempt: row.attempt, nativeSessionId: row.entireSessionId!, traceId: row.workerTraceId });
    if (!id) throw new Error(`Worker trace read-back failed for ${row.taskId} attempt ${row.attempt}; saved status was not changed`);
    row.workerTraceId = id;
    traceIds.push(id);
  }
  const completed = (options.now ?? (() => new Date()))().toISOString();
  run.updatedAt = completed;
  run.integrations.neatlogs = { status: 'ok', detail: `Worker trace delivery completed after the run at ${completed}; read-back verified: ${[...new Set(traceIds)].join(', ')}.` };
  if (!validateRunState(run).ok || !validateLedger(ledger).ok) throw new Error('Recovered evidence failed schema validation');
  if (readFileSync(runPath, 'utf8') !== originalRun || readFileSync(ledgerPath, 'utf8') !== originalLedger) throw new Error('Saved run changed during recovery; refusing to overwrite');
  if (!existsSync(`${runPath}.before-trace-recovery`)) writeFileSync(`${runPath}.before-trace-recovery`, originalRun);
  if (!existsSync(`${ledgerPath}.before-trace-recovery`)) writeFileSync(`${ledgerPath}.before-trace-recovery`, originalLedger);
  // Write verified attempt evidence first, then the status that references it.
  replaceJson(ledgerPath, ledger);
  replaceJson(runPath, run);
  const latestDir = join(dirname(outputDir), 'latest');
  const latestPath = join(latestDir, 'run.json');
  if (existsSync(latestPath) && (JSON.parse(readFileSync(latestPath, 'utf8')) as RunState).runId === run.runId) {
    replaceJson(join(latestDir, 'ledger.json'), ledger);
    replaceJson(latestPath, run);
  }
  return { before, after: run.integrations.neatlogs, traceIds };
}
