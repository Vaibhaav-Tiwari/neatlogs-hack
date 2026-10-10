import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SpanSpool } from '@neatlogs/codex';
import { NeatlogsWorkerSpoolAdapter } from './neatlogs-worker-spool.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tally-spool-'));
  const spool = new SpanSpool(root);
  const enqueue = (session: string, cwd?: string) => spool.enqueue([{
    traceId: randomBytes(16), spanId: randomBytes(8), name: 'tool', kind: 1, startTimeUnixNano: '1', endTimeUnixNano: '2',
    attributes: [{ key: 'neatlogs.session.id', value: { stringValue: session } }, ...(cwd ? [{ key: 'neatlogs.workflow.cwd', value: { stringValue: cwd } }] : [])],
  }], 'worker')!;
  return { root, spool, enqueue };
}

describe('NeatlogsWorkerSpoolAdapter', () => {
  it('drains only the selected worker through the SDK, including its earlier child spans', async () => {
    const { root, spool, enqueue } = fixture();
    const child = enqueue('native');
    const rootBatch = enqueue('native', '/worker');
    const other = enqueue('other', '/another-worker');
    let sent = 0;
    const adapter = new NeatlogsWorkerSpoolAdapter({ root, exporter: { exportSpans: async () => { sent += 1; return 'success'; } } });
    await adapter.drainWorker({ checkoutPath: '/worker' });
    expect(sent).toBe(2);
    expect(existsSync(child)).toBe(false);
    expect(existsSync(rootBatch)).toBe(false);
    expect(spool.pendingFiles()).toEqual([other]);
    expect(adapter.status()).toEqual({ status: 'ok', detail: null });
  });

  it.each(['terminal', 'retryable'] as const)('retains a %s failure without deleting or modifying queued data', async (failure) => {
    const { root, enqueue } = fixture();
    const path = enqueue('native');
    const original = readFileSync(path, 'utf8');
    const adapter = new NeatlogsWorkerSpoolAdapter({ root, exporter: { exportSpans: async () => failure } });
    await adapter.drainWorker({ checkoutPath: null, entireSessionId: 'native' });
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(adapter.status().status).toBe('missing');
  });

  it('retains malformed and unrelated batches and respects another drain lock', async () => {
    const { root, enqueue } = fixture();
    const path = enqueue('native');
    const malformed = join(root, 'spool', 'pending', 'broken.json');
    writeFileSync(malformed, 'invalid json');
    writeFileSync(join(root, 'spool', 'drain.lock'), '');
    const adapter = new NeatlogsWorkerSpoolAdapter({ root, exporter: { exportSpans: async () => { throw new Error('must not export while locked'); } } });
    await adapter.drainWorker({ checkoutPath: null, entireSessionId: 'native' });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(malformed, 'utf8')).toBe('invalid json');
    expect(adapter.status().detail).toContain('another drain holds the lock');
  });
});
