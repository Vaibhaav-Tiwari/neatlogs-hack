import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunState, LedgerRow } from '../schema/types.js';
import { recoverRunTraces } from './trace-recovery.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tally-trace-recovery-'));
  const outputDir = join(root, 'run-recovery'); mkdirSync(outputDir);
  const run = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/run.json', import.meta.url), 'utf8')) as RunState;
  const rows = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/ledger.json', import.meta.url), 'utf8')) as LedgerRow[];
  run.runId = 'run-recovery'; run.dryRun = false;
  run.integrations.neatlogs = { status: 'missing', detail: 'Worker batches pending' };
  const ledger: LedgerRow[] = rows.map((r, i) => ({ ...r, runId: run.runId, sessionId: `ao-${i}`, entireSessionId: `native-${i}`, costSource: 'list-price', workerTraceId: null }));
  writeFileSync(join(outputDir, 'run.json'), JSON.stringify(run));
  writeFileSync(join(outputDir, 'ledger.json'), JSON.stringify(ledger));
  return { root, outputDir, run, ledger };
}

describe('recoverRunTraces', () => {
  it('refreshes latest only when it points at the verified run', async () => {
    const { root, outputDir, run, ledger } = fixture();
    const latest = join(root, 'latest'); mkdirSync(latest);
    writeFileSync(join(latest, 'run.json'), JSON.stringify(run));
    writeFileSync(join(latest, 'ledger.json'), JSON.stringify(ledger));
    await recoverRunTraces({ runId: run.runId, outputDir, drain: { drainWorker: async () => {} }, reader: { verifyFor: async () => 'a'.repeat(32) } });
    expect(readFileSync(join(latest, 'run.json'), 'utf8')).toBe(readFileSync(join(outputDir, 'run.json'), 'utf8'));
    expect(readFileSync(join(latest, 'ledger.json'), 'utf8')).toBe(readFileSync(join(outputDir, 'ledger.json'), 'utf8'));
  });
  it('updates only verified finished-run status and keeps decision trace ids unchanged', async () => {
    const { root, outputDir, ledger } = fixture();
    const latest = join(root, 'latest'); mkdirSync(latest);
    writeFileSync(join(latest, 'run.json'), JSON.stringify({ runId: 'unrelated-newer-run' }));
    const drained: string[] = [];
    const result = await recoverRunTraces({ runId: 'run-recovery', outputDir,
      drain: { drainWorker: async c => { expect(c.checkoutPath).toBeNull(); drained.push(c.entireSessionId!); } },
      reader: { verifyFor: async c => { expect(drained).toContain(c.nativeSessionId); return 'a'.repeat(32); } } });
    expect(result.before.status).toBe('missing');
    expect(result.after.status).toBe('ok');
    expect(result.after.detail).toContain('completed after the run');
    const saved = JSON.parse(readFileSync(join(outputDir, 'ledger.json'), 'utf8')) as LedgerRow[];
    expect(saved.every(r => r.workerTraceId === 'a'.repeat(32))).toBe(true);
    expect(saved.map(r => r.traceId)).toEqual(ledger.map(r => r.traceId));
    expect(JSON.parse(readFileSync(join(latest, 'run.json'), 'utf8')).runId).toBe('unrelated-newer-run');
    expect(readFileSync(join(outputDir, 'run.json.before-trace-recovery'), 'utf8')).toContain('missing');
  });

  it.each(['readback', 'pending', 'dry', 'running', 'native'])('does not update saved evidence when %s verification fails', async failure => {
    const { outputDir, run, ledger } = fixture();
    if (failure === 'dry') run.dryRun = true;
    if (failure === 'running') run.status = 'running';
    if (failure === 'native') ledger[0]!.entireSessionId = null;
    writeFileSync(join(outputDir, 'run.json'), JSON.stringify(run));
    writeFileSync(join(outputDir, 'ledger.json'), JSON.stringify(ledger));
    const beforeRun = readFileSync(join(outputDir, 'run.json'), 'utf8');
    const beforeLedger = readFileSync(join(outputDir, 'ledger.json'), 'utf8');
    await expect(recoverRunTraces({ runId: 'run-recovery', outputDir,
      drain: { drainWorker: async () => {}, status: () => ({ status: failure === 'pending' ? 'missing' : 'ok', detail: null }) },
      reader: { verifyFor: async () => failure === 'readback' ? null : 'a'.repeat(32) } })).rejects.toThrow();
    expect(readFileSync(join(outputDir, 'run.json'), 'utf8')).toBe(beforeRun);
    expect(readFileSync(join(outputDir, 'ledger.json'), 'utf8')).toBe(beforeLedger);
  });
});
