import { loadEnv } from '../engine/env.js';
import { workerCorrelationPrefix } from '../engine/worker-correlation.js';

export interface WorkerTraceReadContext {
  runId: string;
  taskId: string;
  attempt: number;
  nativeSessionId?: string | null;
  traceId?: string | null;
}

export interface WorkerTraceReaderPort {
  verifyFor(context: WorkerTraceReadContext): Promise<string | null>;
}

interface TraceRecord {
  traceId?: string;
  sessionId?: string;
  workflowName?: string;
  traceName?: string;
}

function matches(trace: TraceRecord, context: WorkerTraceReadContext): boolean {
  if (!trace.sessionId || trace.sessionId === context.runId || (context.nativeSessionId && trace.sessionId !== context.nativeSessionId)) return false;
  return [trace.workflowName, trace.traceName].some(name => {
    if (!name) return false;
    if (name.startsWith(workerCorrelationPrefix(context.runId, context.taskId, context.attempt))) return true;
    const legacy = /Tally run ([^,]+), task ([^,]+), attempt (\d+)(?:[:\s]|$)/.exec(name);
    return legacy?.[1] === context.runId && legacy[2] === context.taskId && Number(legacy[3]) === context.attempt;
  });
}

export class NeatlogsWorkerTraceReader implements WorkerTraceReaderPort {
  private readonly env: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: { env?: Record<string, string>; fetch?: typeof fetch; endpoint?: string; retries?: number; retryDelayMs?: number } = {}) {
    this.env = options.env ?? loadEnv();
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? 'https://app.neatlogs.com/api/v1/public';
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  async verifyFor(context: WorkerTraceReadContext): Promise<string | null> {
    if (!this.env.NEATLOGS_TOKEN || !this.env.NEATLOGS_PROJECT_ID) return null;
    for (let retry = 0; retry < this.retries; retry++) {
      try {
        const candidates = context.traceId ? [context.traceId] : await this.discover(context);
        for (const id of candidates) {
          if (!/^[0-9a-f]{32}$/i.test(id)) continue;
          const detail = await this.read(`/traces/${id}`) as { data?: TraceRecord } | null;
          if (!detail?.data || detail.data.traceId !== id || !matches(detail.data, context)) continue;
          const spans = await this.read(`/traces/${id}/spans`) as { data?: { spans?: unknown[] } } | null;
          // A trace-list stub/app shell is not delivery proof. Killed turns may have
          // zero aggregate tokens yet still have readable tool spans.
          if (Array.isArray(spans?.data?.spans) && spans.data.spans.length > 0) return id;
        }
      } catch { /* Network/auth/processing failure cannot establish delivery. */ }
      if (retry + 1 < this.retries) await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
    }
    return null;
  }

  private async discover(context: WorkerTraceReadContext): Promise<string[]> {
    let cursor: string | undefined;
    const ids: string[] = [];
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
      const body = await this.read(`/traces?${query}`) as { data?: { traces?: TraceRecord[]; page?: { nextCursor?: string; hasMore?: boolean } } } | null;
      if (!Array.isArray(body?.data?.traces)) break;
      for (const trace of body.data.traces) if (matches(trace, context) && trace.traceId) ids.push(trace.traceId);
      if (ids.length || !body.data.page?.hasMore || !body.data.page.nextCursor) break;
      cursor = body.data.page.nextCursor;
    }
    return ids;
  }

  private async read(path: string): Promise<unknown | null> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      headers: { Authorization: `Bearer ${this.env.NEATLOGS_TOKEN}`, 'x-project-id': this.env.NEATLOGS_PROJECT_ID! },
      signal: AbortSignal.timeout(10000),
    });
    return response.ok ? response.json() : null;
  }
}
