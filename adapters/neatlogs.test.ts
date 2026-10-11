import { describe, expect, it } from 'vitest';
import { NeatlogsTraceAdapter, type NeatlogsSdk } from './neatlogs.js';

class FakeNeatlogs implements NeatlogsSdk {
  initCalls: Array<{ apiKey: string; workflowName: string; tags?: string[] }> = [];
  traceCalls: Array<{ name: string; sessionId?: string; input?: unknown; attributes?: unknown }> = [];
  flushed = 0;
  shutDown = 0;

  async init(options: { apiKey: string; workflowName: string; tags?: string[] }): Promise<void> {
    this.initCalls.push(options);
  }

  async trace<T>(options: { name: string; kind: 'CHAIN'; sessionId?: string; input?: unknown; attributes?: unknown }, fn: () => Promise<T>): Promise<T> {
    this.traceCalls.push(options);
    return fn();
  }

  injectTraceContext(carrier: Record<string, string>): void {
    carrier.traceparent = '00-1234567890abcdef1234567890abcdef-abcdef1234567890-01';
  }

  async flush(): Promise<void> {
    this.flushed += 1;
  }

  async shutdown(): Promise<void> {
    this.shutDown += 1;
  }
}

describe('NeatlogsTraceAdapter', () => {
  it('keeps decision ids per run/task/attempt when worker polling interleaves', async () => {
    const sdk = new FakeNeatlogs();
    let serial = 0;
    sdk.injectTraceContext = carrier => { carrier.traceparent = `00-${String(++serial).padStart(32, '0')}-abcdef1234567890-01`; };
    const adapter = new NeatlogsTraceAdapter({ env: { NEATLOGS_API_KEY: 'fake' }, sdk });
    await adapter.span('tally.route', { sessionId: 'run-1', taskId: 'T1', attempt: 1 }, async () => {});
    await adapter.span('tally.route', { sessionId: 'run-1', taskId: 'T2', attempt: 1 }, async () => {});
    await adapter.span('tally.ceiling.poll', { sessionId: 'worker-1', taskId: 'T1' }, async () => {});
    expect(adapter.lastTraceId('run-1', 'T1', 1)).toBe('1'.padStart(32, '0'));
    expect(adapter.lastTraceId('run-1', 'T2', 1)).toBe('2'.padStart(32, '0'));
    expect(adapter.lastTraceId()).toBe('3'.padStart(32, '0'));
  });
  it('is off and acts as a no-op when the key is missing', async () => {
    const adapter = new NeatlogsTraceAdapter({ env: {}, sdk: new FakeNeatlogs() });
    let called = false;
    await adapter.span('tally.route', { taskId: 'T1' }, async (span) => {
      span.set({ action: 'start' });
      called = true;
    });
    expect(called).toBe(true);
    expect(adapter.status()).toEqual({ status: 'missing', detail: 'NEATLOGS_API_KEY is missing' });
    expect(adapter.lastTraceId()).toBeNull();
  });

  it('initialises the SDK, passes sessionId on trace(), and captures the trace id', async () => {
    const sdk = new FakeNeatlogs();
    const adapter = new NeatlogsTraceAdapter({ env: { NEATLOGS_API_KEY: 'secret-key' }, sdk, workflowName: 'wf', tags: ['one'] });
    await adapter.span('tally.ceiling.poll', { sessionId: 'sess-1', taskId: 'T1' }, async (span) => {
      span.set({ action: 'stop' });
    });
    expect(sdk.initCalls).toEqual([{ apiKey: 'secret-key', workflowName: 'wf', tags: ['one'] }]);
    expect(sdk.traceCalls).toMatchObject([{ name: 'tally.ceiling.poll', sessionId: 'sess-1' }]);
    expect(sdk.traceCalls[0]?.attributes).toMatchObject({ sessionId: 'sess-1', taskId: 'T1' });
    expect(JSON.stringify(sdk.initCalls)).not.toContain('NEATLOGS_API_KEY');
    expect(adapter.lastTraceId()).toBe('1234567890abcdef1234567890abcdef');
    expect(adapter.status()).toEqual({ status: 'ok', detail: '1234567890abcdef1234567890abcdef' });
  });

  it('flushes before shutdown', async () => {
    const sdk = new FakeNeatlogs();
    const adapter = new NeatlogsTraceAdapter({ env: { NEATLOGS_API_KEY: 'secret-key' }, sdk });
    await adapter.shutdown();
    expect(sdk.flushed).toBe(1);
    expect(sdk.shutDown).toBe(1);
  });

  it.each(['tally.route', 'tally.baseline.route', 'tally.escalate'])('exposes run/task/attempt in the public name of %s', async name => {
    const sdk = new FakeNeatlogs();
    const adapter = new NeatlogsTraceAdapter({ env: { NEATLOGS_API_KEY: 'secret-key' }, sdk });
    await adapter.span(name, { sessionId: 'run-20261011-092229Z', taskId: '#9', attempt: 2 }, async () => {});
    expect(sdk.traceCalls[0]).toMatchObject({
      name: `${name}: Tally run run-20261011-092229Z, task #9, attempt 2`,
      sessionId: 'run-20261011-092229Z',
      input: { sessionId: 'run-20261011-092229Z', taskId: '#9', attempt: 2 },
    });
  });

  it('keeps history record names unchanged even when they carry attempt context', async () => {
    const sdk = new FakeNeatlogs();
    const adapter = new NeatlogsTraceAdapter({ env: { NEATLOGS_API_KEY: 'secret-key' }, sdk });
    const name = 'tally.history.record {"size":"small","tier":"cheap"}';
    await adapter.span(name, { sessionId: 'run-1', taskId: '#9', attempt: 1 }, async () => {});
    expect(sdk.traceCalls[0]?.name).toBe(name);
  });

  it('does not invent missing decision attempt context', async () => {
    const sdk = new FakeNeatlogs();
    const adapter = new NeatlogsTraceAdapter({ env: { NEATLOGS_API_KEY: 'secret-key' }, sdk });
    await adapter.span('tally.route', { sessionId: 'run-1', taskId: '#9' }, async () => {});
    expect(sdk.traceCalls[0]?.name).toBe('tally.route');
  });

  it('turns off when the SDK cannot be loaded', async () => {
    const adapter = new NeatlogsTraceAdapter({
      env: { NEATLOGS_API_KEY: 'secret-key' },
      loadSdk: async () => {
        throw new Error('not installed');
      },
    });
    await adapter.span('tally.route', {}, async () => {});
    expect(adapter.status()).toEqual({ status: 'missing', detail: 'neatlogs SDK is not available' });
  });
});
