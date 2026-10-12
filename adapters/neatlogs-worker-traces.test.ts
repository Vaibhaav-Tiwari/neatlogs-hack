import { describe, expect, it } from 'vitest';
import { NeatlogsWorkerTraceReader } from './neatlogs-worker-traces.js';
import { workerCorrelationPrefix } from '../engine/worker-correlation.js';

const context = { runId: 'run-1', taskId: 'T1', attempt: 1, nativeSessionId: 'native' };
const traceId = 'a'.repeat(32);
const trace = { traceId, sessionId: 'native', workflowName: 'You are implementing Tally run run-1, task T1, attempt 1: Fix calc' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const env = { NEATLOGS_TOKEN: 'fake-read-token', NEATLOGS_PROJECT_ID: 'fake-project' };

describe('NeatlogsWorkerTraceReader', () => {
  it('reads all correlated failure span pages and preserves status evidence', async () => {
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/spans')) return json(trace);
      if (url.searchParams.has('cursor')) return json({ spans: [{ spanId: 's2', spanName: 'Bash', spanType: 'TOOL', status: 'OK' }] });
      return json({
        spans: [{ spanId: 's1', spanName: 'Bash', spanType: 'TOOL', status: 'ERROR', errorMessage: 'permission denied' }],
        ...(url.search ? { page: { hasMore: true, nextCursor: 'opaque' } } : {}),
      });
    } });
    const result = await reader.failureFor({ ...context, traceId });
    expect(result).toMatchObject({ traceId, spans: [
      { id: 's1', status: 'ERROR', error: 'permission denied' }, { id: 's2', status: 'OK' },
    ] });
  });

  it('refuses failure evidence from an unrelated worker', async () => {
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async () => json({ ...trace, workflowName: 'another task' }) });
    expect(await reader.failureFor({ ...context, traceId })).toBeNull();
  });

  it('returns unavailable for incomplete span pagination rather than claiming an unrecovered denial', async () => {
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/spans')) return json(trace);
      return json({ spans: [{ spanId: 's1' }], ...(url.search ? { page: { hasMore: true, nextCursor: 'repeat' } } : {}) });
    } });
    expect(await reader.failureFor({ ...context, traceId })).toBeNull();
  });

  it.each(['run-20261011-102312Z', 'long-run-id-'.repeat(20)])('reads the truncated compact prefix for three-digit issues and attempt 2: %s', async runId => {
    const input = { runId, taskId: '#123', attempt: 2, nativeSessionId: 'native' };
    const prefix = workerCorrelationPrefix(runId, input.taskId, input.attempt);
    expect(prefix.length).toBeLessThanOrEqual(55);
    expect(prefix).toContain('#123 a2:');
    const candidate = { ...trace, workflowName: `${prefix} ${'Long task title '.repeat(20)}`.slice(0, 60) };
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async url => {
      if (String(url).includes('?')) return json({ traces: [candidate] });
      return json(String(url).endsWith('/spans') ? { spans: [{}] } : candidate);
    } });
    expect(await reader.verifyFor(input)).toBe(traceId);
    expect(await reader.verifyFor({ ...input, taskId: '#12' })).toBeNull();
    expect(await reader.verifyFor({ ...input, attempt: 1 })).toBeNull();
  });
  it('keeps arbitrarily long task and run ids compact and distinct', () => {
    const run = 'run-with-spaces '.repeat(30), task = 'task-with-spaces '.repeat(30);
    const prefix = workerCorrelationPrefix(run, task, 2);
    expect(prefix.length).toBeLessThanOrEqual(55);
    expect(prefix).not.toBe(workerCorrelationPrefix(run, task + 'other', 2));
  });
  it('verifies a correlated worker without Entire and rejects a CFO decision trace', async () => {
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async input => {
      if (String(input).includes('?')) return json({ traces: [{ ...trace, sessionId: 'run-1' }, trace] });
      return json(String(input).endsWith('/spans') ? { spans: [{}] } : trace);
    } });
    expect(await reader.verifyFor({ runId: 'run-1', taskId: 'T1', attempt: 1 })).toBe(traceId);
  });
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

  it('retries Neatlogs HTTP 409 until the worker span projection is readable', async () => {
    let spanReads = 0;
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 3, retryDelayMs: 0, fetch: async input => {
      const url = String(input);
      if (url.endsWith('/spans')) {
        spanReads++;
        if (spanReads === 1) return new Response('', { status: 409, headers: { 'retry-after': '0' } });
        return json({ spans: [{ spanId: 'ready' }] });
      }
      return json(trace);
    } });

    await expect(reader.verifyFor({ ...context, traceId })).resolves.toBe(traceId);
    expect(spanReads).toBe(2);
    expect(reader.status()).toEqual({ status: 'ok', detail: null });
  });

  it('keeps Neatlogs connected when the span projection remains pending after bounded retries', async () => {
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 2, retryDelayMs: 0, fetch: async input => {
      const url = String(input);
      return url.endsWith('/spans') ? new Response('', { status: 409, headers: { 'retry-after': '0' } }) : json(trace);
    } });

    await expect(reader.verifyFor({ ...context, traceId })).resolves.toBeNull();
    expect(reader.status()).toMatchObject({ status: 'ok', detail: expect.stringContaining('still indexing') });
  });

  it('retries a pending span page while collecting failure evidence', async () => {
    let spanReads = 0;
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 2, retryDelayMs: 0, fetch: async input => {
      const url = String(input);
      if (url.includes('/spans')) {
        spanReads++;
        if (spanReads === 2) return new Response('', { status: 409, headers: { 'retry-after': '0' } });
        return json({ spans: [{ spanId: 'failure', spanName: 'tool', status: 'ERROR' }] });
      }
      return json(trace);
    } });

    await expect(reader.failureFor({ ...context, traceId })).resolves.toMatchObject({
      traceId,
      spans: [{ id: 'failure', status: 'ERROR' }],
    });
    expect(spanReads).toBe(3);
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
    expect(reader.status()).toMatchObject({ status: 'missing', detail: expect.stringContaining('NEATLOGS_TOKEN and NEATLOGS_PROJECT_ID') });
  });

  it.each([
    [401, 'NEATLOGS_TOKEN'],
    [403, 'observability:read scope and project role'],
    [404, 'selected project'],
    [429, 'rate limited'],
    [503, 'temporarily unavailable'],
  ] as const)('reports an actionable public API failure for HTTP %i', async (status, expectedDetail) => {
    const reader = new NeatlogsWorkerTraceReader({ env, retries: 1, fetch: async () => json({}, status) });
    expect(await reader.verifyFor(context)).toBeNull();
    expect(reader.status()).toMatchObject({ status: 'missing', detail: expect.stringContaining(expectedDetail) });
  });
});
