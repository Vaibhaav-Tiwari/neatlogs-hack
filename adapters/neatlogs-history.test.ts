import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistoryWriterPort, PriceStats } from '../agent/ports.js';
import { historyAttributes, historyTraceName, NeatlogsPriceHistory } from './neatlogs-history.js';
import { PriceHistory } from '../agent/history.js';

class FakeHistory implements PriceHistoryPort, PriceHistoryWriterPort {
  records: AttemptOutcome[] = [];

  constructor(private readonly stats: PriceStats | null = null) {}

  async lookup(): Promise<PriceStats | null> {
    return this.stats;
  }

  async record(outcome: AttemptOutcome): Promise<void> {
    this.records.push(outcome);
  }
}

function response(body: unknown, ok = true, status = ok ? 200 : 503): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('NeatlogsPriceHistory', () => {
  it('reads only the actual model from public trace names, including encoded model ids', async () => {
    const model = 'provider/codex terra=v2';
    const history = new NeatlogsPriceHistory({
      fallback: new PriceHistory(), env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async () => response({ data: { traces: [
        { traceName: historyTraceName({ size: 'small', tier: 'cheap', model, result: 'passed', costNanos: 100 }) },
        { traceName: historyTraceName({ size: 'small', tier: 'cheap', model: 'claude', result: 'failed', costNanos: 900 }) },
        { traceName: historyTraceName({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 1 }) },
      ] } }),
    });
    expect(await history.lookup('small', 'cheap', model)).toMatchObject({ attempts: 1, passRate: 1, avgCostNanos: 100, source: 'neatlogs' });
    expect(await history.lookup('small', 'cheap', 'claude')).toMatchObject({ attempts: 1, passRate: 0, avgCostNanos: 900 });
    expect(await history.lookup('small', 'cheap', 'new-model')).toBeNull();
    expect(history.status()?.detail).toContain('unknown-model observations excluded');
  });

  it('uses explicit legacy span model attributes without assigning an unknown model', async () => {
    const history = new NeatlogsPriceHistory({
      fallback: new PriceHistory(), env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async input => `${input}`.includes('/traces?')
        ? response({ traces: [{ traceId: 'old', traceName: 'tally.history.record' }] })
        : response({ spans: [
          { name: 'tally.history.record', attributes: historyAttributes({ size: 'small', tier: 'cheap', model: 'codex', result: 'passed', costNanos: 100 }) },
          { name: 'tally.history.record', attributes: historyAttributes({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 1 }) },
        ] }),
    });
    expect(await history.lookup('small', 'cheap', 'codex')).toMatchObject({ attempts: 1, avgCostNanos: 100 });
  });

  it('passes the model through local fallback rather than using old pooled rows', async () => {
    const fallback = new PriceHistory();
    await fallback.record({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 1 });
    await fallback.record({ size: 'small', tier: 'cheap', model: 'codex', result: 'passed', costNanos: 100 });
    const history = new NeatlogsPriceHistory({ fallback, env: {} });
    expect(await history.lookup('small', 'cheap', 'codex')).toMatchObject({ attempts: 1, avgCostNanos: 100, source: 'local' });
    expect(await history.lookup('small', 'cheap', 'claude')).toBeNull();
  });
  it('falls back to the local history when service-account credentials are missing', async () => {
    const fallback = new FakeHistory({ attempts: 2, passRate: 0.5, avgCostNanos: 123 });
    const history = new NeatlogsPriceHistory({ fallback, env: {}, fetch: async () => response([]) });
    await expect(history.lookup('small', 'cheap')).resolves.toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: 123, source: 'local' });
  });

  it('reads pass rate and average cost from neatlogs history traces when credentials are present', async () => {
    const calls: string[] = [];
    const history = new NeatlogsPriceHistory({
      fallback: new FakeHistory(null),
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      endpoint: 'https://app.neatlogs.test/api/v1/public',
      fetch: async (input, init) => {
        calls.push(`${input}`);
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
        expect((init?.headers as Record<string, string>)['x-project-id']).toBe('project');
        if (`${input}`.includes('/traces?')) return response({ data: { page: { hasMore: false, limit: 2, nextCursor: null }, traces: [
          { id: 'trace-1', traceName: 'tally.history.record' }, { traceId: 'trace-2', traceName: 'tally.history.record' },
        ] } });
        if (`${input}`.endsWith('/trace-1/spans')) {
          return response({
            data: {
              spans: [
                { name: 'tally.history.record', attributes: historyAttributes({ size: 'small', tier: 'cheap', result: 'passed', costNanos: usdToNanos(0.12) }) },
                { name: 'tally.history.record', attributes: historyAttributes({ size: 'small', tier: 'cheap', result: 'failed', costNanos: usdToNanos(0.28) }) },
              ],
            },
          });
        }
        return response({
          spans: [{ name: 'tally.history.record', attributes: historyAttributes({ size: 'medium', tier: 'cheap', result: 'passed', costNanos: usdToNanos(0.99) }) }],
        });
      },
    });

    await expect(history.lookup('small', 'cheap')).resolves.toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: usdToNanos(0.2), source: 'neatlogs', successfulCostsNanos: [usdToNanos(0.12)] });
    expect(calls[0]).toContain('workflowName=tally-cfo-agent');
  });

  it('follows opaque trace cursors with a supported page size and a page bound', async () => {
    const traceUrls: URL[] = [];
    const history = new NeatlogsPriceHistory({
      fallback: new FakeHistory(null),
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      limit: 100,
      maxPages: 2,
      fetch: async (input) => {
        const url = new URL(`${input}`);
        if (!url.pathname.endsWith('/traces')) return response({ spans: [] });
        traceUrls.push(url);
        const cursor = url.searchParams.get('cursor');
        if (!cursor) {
          return response({
            data: {
              page: { hasMore: true, limit: 50, nextCursor: 'opaque/cursor+one=' },
              traces: [{ traceName: historyTraceName({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 100 }) }],
            },
          });
        }
        return response({
          data: {
            page: { hasMore: true, limit: 50, nextCursor: 'cursor-three' },
            traces: [{ traceName: historyTraceName({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 300 }) }],
          },
        });
      },
    });

    await expect(history.lookup('small', 'cheap')).resolves.toEqual({ attempts: 2, passRate: 1, avgCostNanos: 200, source: 'neatlogs', successfulCostsNanos: [100, 300] });
    expect(traceUrls).toHaveLength(2);
    expect(traceUrls[0]!.searchParams.get('limit')).toBe('50');
    expect(traceUrls[1]!.searchParams.get('cursor')).toBe('opaque/cursor+one=');
  });

  it('reads observations directly from the public trace list shape returned by neatlogs', async () => {
    const history = new NeatlogsPriceHistory({
      fallback: new FakeHistory(null),
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async (input) => {
        if (`${input}`.includes('/traces?')) {
          return response({
            data: {
              page: { hasMore: false, limit: 3, nextCursor: null },
              traces: [
                { traceId: 'trace-1', traceName: historyTraceName({ size: 'medium', tier: 'middle', result: 'passed', costNanos: 200 }) },
                { traceId: 'trace-2', traceName: historyTraceName({ size: 'medium', tier: 'middle', result: 'stopped', costNanos: 600 }) },
              ],
            },
          });
        }
        return response({ code: 'TRACE_PROCESSING' }, false);
      },
    });
    await expect(history.lookup('medium', 'middle')).resolves.toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: 400, source: 'neatlogs', successfulCostsNanos: [200] });
  });

  it('only reads span details for old history traces that need attribute fallback', async () => {
    const calls: string[] = [];
    const history = new NeatlogsPriceHistory({
      fallback: new FakeHistory(null),
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async (input) => {
        calls.push(`${input}`);
        if (`${input}`.includes('/traces?')) {
          return response({
            data: {
              traces: [
                { traceId: 'route-trace', traceName: 'tally.route' },
                { traceId: 'old-history-trace', traceName: 'tally.history.record' },
              ],
            },
          });
        }
        return response({ data: { spans: [{ name: 'tally.history.record', attributes: historyAttributes({ size: 'large', tier: 'top', result: 'passed', costNanos: 1000 }) }] } });
      },
    });

    await expect(history.lookup('large', 'top')).resolves.toEqual({ attempts: 1, passRate: 1, avgCostNanos: 1000, source: 'neatlogs', successfulCostsNanos: [1000] });
    expect(calls.some((call) => call.includes('/route-trace/spans'))).toBe(false);
    expect(calls.some((call) => call.includes('/old-history-trace/spans'))).toBe(true);
  });

  it('does not fetch spans for unrelated traces with no trace name', async () => {
    let spanReads = 0;
    const history = new NeatlogsPriceHistory({
      fallback: new FakeHistory(null),
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async (input) => {
        if (`${input}`.includes('/traces?')) return response({ traces: [{ id: 'unnamed-trace' }, { id: 'route-trace', traceName: 'tally.route' }] });
        spanReads += 1;
        return response({ spans: [] });
      },
    });

    await expect(history.lookup('small', 'cheap')).resolves.toBeNull();
    expect(spanReads).toBe(0);
  });

  it('falls back to local history when neatlogs read fails or has no matching observations', async () => {
    const fallback = new FakeHistory({ attempts: 1, passRate: 1, avgCostNanos: 55 });
    const failing = new NeatlogsPriceHistory({
      fallback,
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async () => response({}, false, 400),
    });
    await expect(failing.lookup('large', 'top')).resolves.toEqual({ attempts: 1, passRate: 1, avgCostNanos: 55, source: 'local' });
    expect(failing.status()).toMatchObject({ status: 'error', detail: expect.stringContaining('traces read failed: 400') });

    const empty = new NeatlogsPriceHistory({
      fallback,
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async (input) => (`${input}`.includes('/traces?') ? response({ traces: [{ id: 'trace-1' }] }) : response({ spans: [] })),
    });
    await expect(empty.lookup('large', 'top')).resolves.toEqual({ attempts: 1, passRate: 1, avgCostNanos: 55, source: 'local' });
    expect(empty.status()).toMatchObject({ status: 'ok', detail: expect.stringContaining('No usable Neatlogs price-history observations') });
  });

  it('aborts a stalled remote history read and reuses local history for every lookup', async () => {
    const fallback = new FakeHistory({ attempts: 2, passRate: 0.5, avgCostNanos: 55 });
    let calls = 0;
    const history = new NeatlogsPriceHistory({
      fallback,
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      timeoutMs: 5,
      fetch: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    await expect(history.lookup('small', 'cheap')).resolves.toMatchObject({ attempts: 2, passRate: 0.5, avgCostNanos: 55, source: 'local' });
    await expect(history.lookup('medium', 'middle')).resolves.toMatchObject({ attempts: 2, passRate: 0.5, avgCostNanos: 55, source: 'local' });
    expect(calls).toBe(1);
    expect(history.status()).toMatchObject({ status: 'error', detail: expect.stringMatching(/timeout|abort/i) });
  });

  it('loads remote observations once and shares the snapshot across tier lookups', async () => {
    let calls = 0;
    const history = new NeatlogsPriceHistory({
      fallback: new FakeHistory(null),
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async () => {
        calls += 1;
        return response({ traces: [{ traceName: historyTraceName({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 100 }) }] });
      },
    });

    await expect(history.lookup('small', 'cheap')).resolves.toMatchObject({ attempts: 1, passRate: 1, avgCostNanos: 100, source: 'neatlogs', successfulCostsNanos: [100] });
    await expect(history.lookup('small', 'middle')).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it('continues recording to the local fallback', async () => {
    const fallback = new FakeHistory();
    const history = new NeatlogsPriceHistory({ fallback, env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' }, fetch: async () => { throw new Error('record must not fetch'); } });
    await history.record({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 7 });
    expect(fallback.records).toEqual([{ size: 'small', tier: 'cheap', result: 'passed', costNanos: 7 }]);
  });
});
