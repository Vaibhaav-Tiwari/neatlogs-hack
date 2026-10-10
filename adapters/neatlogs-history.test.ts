import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistoryWriterPort, PriceStats } from '../agent/ports.js';
import { historyAttributes, NeatlogsPriceHistory } from './neatlogs-history.js';

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

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => body } as Response;
}

describe('NeatlogsPriceHistory', () => {
  it('falls back to the local history when service-account credentials are missing', async () => {
    const fallback = new FakeHistory({ attempts: 2, passRate: 0.5, avgCostNanos: 123 });
    const history = new NeatlogsPriceHistory({ fallback, env: {}, fetch: async () => response([]) });
    await expect(history.lookup('small', 'cheap')).resolves.toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: 123 });
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
        if (`${input}`.includes('/traces?')) return response({ traces: [{ id: 'trace-1' }, { traceId: 'trace-2' }] });
        if (`${input}`.endsWith('/trace-1/spans')) {
          return response({
            spans: [
              { name: 'tally.history.record', attributes: historyAttributes({ size: 'small', tier: 'cheap', result: 'passed', costNanos: usdToNanos(0.12) }) },
              { name: 'tally.history.record', attributes: historyAttributes({ size: 'small', tier: 'cheap', result: 'failed', costNanos: usdToNanos(0.28) }) },
            ],
          });
        }
        return response({
          spans: [{ name: 'tally.history.record', attributes: historyAttributes({ size: 'medium', tier: 'cheap', result: 'passed', costNanos: usdToNanos(0.99) }) }],
        });
      },
    });

    await expect(history.lookup('small', 'cheap')).resolves.toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: usdToNanos(0.2) });
    expect(calls[0]).toContain('workflowName=tally-cfo-agent');
  });

  it('falls back to local history when neatlogs read fails or has no matching observations', async () => {
    const fallback = new FakeHistory({ attempts: 1, passRate: 1, avgCostNanos: 55 });
    const failing = new NeatlogsPriceHistory({
      fallback,
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async () => response({}, false),
    });
    await expect(failing.lookup('large', 'top')).resolves.toEqual({ attempts: 1, passRate: 1, avgCostNanos: 55 });

    const empty = new NeatlogsPriceHistory({
      fallback,
      env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' },
      fetch: async (input) => (`${input}`.includes('/traces?') ? response({ traces: [{ id: 'trace-1' }] }) : response({ spans: [] })),
    });
    await expect(empty.lookup('large', 'top')).resolves.toEqual({ attempts: 1, passRate: 1, avgCostNanos: 55 });
  });

  it('continues recording to the local fallback', async () => {
    const fallback = new FakeHistory();
    const history = new NeatlogsPriceHistory({ fallback, env: { NEATLOGS_TOKEN: 'token', NEATLOGS_PROJECT_ID: 'project' } });
    await history.record({ size: 'small', tier: 'cheap', result: 'passed', costNanos: 7 });
    expect(fallback.records).toEqual([{ size: 'small', tier: 'cheap', result: 'passed', costNanos: 7 }]);
  });
});
