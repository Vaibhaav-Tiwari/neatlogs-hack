import { describe, expect, it } from 'vitest';
import { NeatlogsWorkerTraceReader } from './neatlogs-worker-traces.js';

const context = { runId: 'run-1', taskId: 'T1', attempt: 1, nativeSessionId: 'native' };
const traceId = 'a'.repeat(32);
const trace = { traceId, sessionId: 'native', workflowName: 'You are implementing Tally run run-1, task T1, attempt 1: Fix calc' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const env = { NEATLOGS_TOKEN: 'fake-read-token', NEATLOGS_PROJECT_ID: 'fake-project' };

describe('NeatlogsWorkerTraceReader', () => {
  it('verifies correlation and readable stopped-worker spans even when aggregate tokens are zero', async () => {
    const calls: string[] = [];
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      const url = String(input); calls.push(url);
      if (url.includes('?')) return json({ traces: [trace], page: { hasMore: false } });
      if (url.endsWith('/spans')) return json({ spans: [{ name: 'tool' }] });
      return json({ ...trace, spansCount: 0, totalTokens: 0 });
    } });
    expect(await reader.verifyFor(context)).toBe(traceId);
    expect(calls).toHaveLength(3);
  });

  it('accepts the public API trace id alias when traceId is not present', async () => {
    const publicTrace = { id: traceId, sessionId: 'native', workflowName: trace.workflowName };
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      const url = String(input);
      if (url.includes('?')) return json({ traces: [publicTrace], page: { hasMore: false } });
      if (url.endsWith('/spans')) return json({ spans: [{}] });
      return json({ ...publicTrace, spansCount: 1, totalTokens: 0 });
    } });

    await expect(reader.verifyFor(context)).resolves.toBe(traceId);
  });

  it.each(['session', 'run', 'task', 'attempt', 'id', 'spans', 'empty', 'detail'])('does not verify a %s mismatch or incomplete response', async fault => {
    const candidate = { ...trace, ...(fault === 'session' ? { sessionId: 'other' } : {}) };
    if (fault === 'run') candidate.workflowName = candidate.workflowName.replace('run-1', 'run-other');
    if (fault === 'task') candidate.workflowName = candidate.workflowName.replace('T1,', 'T2,');
    if (fault === 'attempt') candidate.workflowName = candidate.workflowName.replace('attempt 1:', 'attempt 2:');
    if (fault === 'id') candidate.traceId = 'b'.repeat(32);
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      if (String(input).includes('?')) return json({ traces: [trace] });
      if (String(input).endsWith('/spans')) return fault === 'spans' ? json({}, 409) : json({ spans: fault === 'empty' ? [] : [{}] });
      return fault === 'detail' ? json({}, 404) : json(candidate);
    } });
    expect(await reader.verifyFor(context)).toBeNull();
  });

  it('follows supported pagination and verifies an explicitly stored worker trace without listing', async () => {
    const calls: string[] = [];
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      const url = String(input); calls.push(url);
      if (url.includes('cursor=')) return json({ traces: [trace] });
      if (url.includes('?')) return json({ traces: [], page: { hasMore: true, nextCursor: 'fake-cursor' } });
      return json(url.endsWith('/spans') ? { spans: [{}] } : trace);
    } });
    expect(await reader.verifyFor(context)).toBe(traceId);
    expect(calls[1]).toContain('cursor=fake-cursor');
    calls.length = 0;
    expect(await reader.verifyFor({ ...context, traceId })).toBe(traceId);
    expect(calls).toHaveLength(2);
  });

  it('does not read without Tally read credentials', async () => {
    const reader = new NeatlogsWorkerTraceReader({ env: {}, fetch: async () => { throw new Error('must not request'); } });
    expect(await reader.verifyFor(context)).toBeNull();
  });
});
