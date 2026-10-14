import { loadEnv } from '../engine/env.js';
import { workerCorrelationPrefix } from '../engine/worker-correlation.js';
class TraceProjectionPending extends Error {
    retryAfterMs;
    constructor(retryAfterMs) {
        super('Neatlogs has not finished building this trace span projection.');
        this.retryAfterMs = retryAfterMs;
        this.name = 'TraceProjectionPending';
    }
}
function retryAfterMs(response) {
    const value = response.headers.get('retry-after');
    if (!value)
        return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.min(10_000, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.min(10_000, Math.max(0, date - Date.now())) : null;
}
function matches(trace, context) {
    if (!trace.sessionId || trace.sessionId === context.runId || (context.nativeSessionId && trace.sessionId !== context.nativeSessionId))
        return false;
    return [trace.workflowName, trace.traceName].some(name => {
        if (!name)
            return false;
        if (name.startsWith(workerCorrelationPrefix(context.runId, context.taskId, context.attempt)))
            return true;
        const legacy = /Tally run ([^,]+), task ([^,]+), attempt (\d+)(?:[:\s]|$)/.exec(name);
        return legacy?.[1] === context.runId && legacy[2] === context.taskId && Number(legacy[3]) === context.attempt;
    });
}
export class NeatlogsWorkerTraceReader {
    env;
    fetchImpl;
    endpoint;
    retries;
    retryDelayMs;
    state = { status: 'ok', detail: null };
    constructor(options = {}) {
        this.env = options.env ?? loadEnv();
        this.fetchImpl = options.fetch ?? fetch;
        this.endpoint = options.endpoint ?? 'https://app.neatlogs.com/api/v1/public';
        this.retries = options.retries ?? 6;
        this.retryDelayMs = options.retryDelayMs ?? 500;
    }
    status() { return this.state; }
    async failureFor(context) {
        const id = await this.verifyFor(context);
        if (!id)
            return null;
        const spans = [];
        let cursor;
        const seen = new Set();
        for (let page = 0; page < 5; page++) {
            const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
            const body = await this.readFailureSpans(id, query);
            if (!Array.isArray(body?.data?.spans))
                return null;
            for (const span of body.data.spans) {
                const text = (value) => typeof value === 'string' ? value : '';
                spans.push({
                    id: text(span.spanId), name: text(span.spanName ?? span.name), type: text(span.spanType),
                    status: text(span.status), error: text(span.errorMessage), startedAt: text(span.startedAt),
                });
            }
            if (!body.data.page?.hasMore)
                return { traceId: id, spans };
            cursor = body.data.page.nextCursor;
            if (!cursor || seen.has(cursor))
                return null;
            seen.add(cursor);
        }
        // Partial history cannot prove that an early denial was unrecovered.
        return null;
    }
    fail(detail) {
        this.state = { status: 'missing', detail };
    }
    async readFailureSpans(id, query) {
        for (let retry = 0; retry < this.retries; retry++) {
            try {
                const body = await this.read(`/traces/${id}/spans?${query}`);
                if (body)
                    this.state = { status: 'ok', detail: null };
                return body;
            }
            catch (error) {
                if (!(error instanceof TraceProjectionPending))
                    throw error;
                this.state = { status: 'ok', detail: 'Neatlogs is still indexing this worker trace; Tally retried the span read.' };
                if (retry + 1 < this.retries) {
                    const backoff = Math.min(5000, this.retryDelayMs * (2 ** retry));
                    await new Promise(resolve => setTimeout(resolve, error.retryAfterMs ?? backoff));
                }
            }
        }
        this.state = { status: 'ok', detail: 'Neatlogs is still indexing this worker trace; failure-span analysis is temporarily unavailable.' };
        return null;
    }
    async verifyFor(context) {
        this.state = { status: 'ok', detail: null };
        if (!this.env.NEATLOGS_TOKEN || !this.env.NEATLOGS_PROJECT_ID) {
            this.fail('Neatlogs worker trace read-back needs NEATLOGS_TOKEN and NEATLOGS_PROJECT_ID in ~/.tally/.env.');
            return null;
        }
        for (let retry = 0; retry < this.retries; retry++) {
            let retryDelay = null;
            try {
                const candidates = context.traceId ? [context.traceId] : await this.discover(context);
                if (!candidates.length && this.state.status === 'ok') {
                    this.fail('No correlated worker trace found in up to 250 recent traces (5 pages at 50/page); check Neatlogs hook trust/setup and NEATLOGS_PROJECT_ID.');
                }
                for (const id of candidates) {
                    if (!/^[0-9a-f]{32}$/i.test(id))
                        continue;
                    const detail = await this.read(`/traces/${id}`);
                    if (!detail?.data || detail.data.traceId !== id || !matches(detail.data, context))
                        continue;
                    const spans = await this.read(`/traces/${id}/spans`);
                    // A trace-list stub/app shell is not delivery proof. Killed turns may have
                    // zero aggregate tokens yet still have readable tool spans.
                    if (Array.isArray(spans?.data?.spans) && spans.data.spans.length > 0) {
                        this.state = { status: 'ok', detail: null };
                        return id;
                    }
                    if (this.state.status === 'ok')
                        this.fail(`Neatlogs trace ${id} matched the worker but has no readable spans yet; retry after ingestion finishes.`);
                }
            }
            catch (error) {
                if (error instanceof TraceProjectionPending) {
                    retryDelay = error.retryAfterMs;
                    this.state = { status: 'ok', detail: 'Neatlogs is still indexing this worker trace; Tally retried the span read.' };
                }
                else {
                    const name = error instanceof Error ? error.name : 'unknown error';
                    this.fail(name === 'AbortError' || name === 'TimeoutError'
                        ? 'Neatlogs worker trace read-back timed out; check connectivity and retry.'
                        : `Neatlogs worker trace read-back request failed (${name}); check connectivity and retry.`);
                }
            }
            if (retry + 1 < this.retries) {
                const backoff = Math.min(5000, this.retryDelayMs * (2 ** retry));
                await new Promise(resolve => setTimeout(resolve, retryDelay ?? backoff));
            }
        }
        return null;
    }
    async discover(context) {
        let cursor;
        const ids = [];
        for (let page = 0; page < 5; page++) {
            const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
            const body = await this.read(`/traces?${query}`);
            if (!Array.isArray(body?.data?.traces))
                break;
            for (const trace of body.data.traces)
                if (matches(trace, context) && trace.traceId)
                    ids.push(trace.traceId);
            if (ids.length || !body.data.page?.hasMore || !body.data.page.nextCursor)
                break;
            cursor = body.data.page.nextCursor;
        }
        return ids;
    }
    async read(path) {
        const response = await this.fetchImpl(`${this.endpoint}${path}`, {
            headers: { Authorization: `Bearer ${this.env.NEATLOGS_TOKEN}`, 'x-project-id': this.env.NEATLOGS_PROJECT_ID },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            const operation = path.includes('/spans') ? 'worker span read-back' : 'worker trace read-back';
            if (response.status === 409 && path.includes('/spans'))
                throw new TraceProjectionPending(retryAfterMs(response));
            const detail = response.status === 401
                ? `Neatlogs ${operation} was unauthorized (HTTP 401); check NEATLOGS_TOKEN and its project binding.`
                : response.status === 403
                    ? `Neatlogs ${operation} was forbidden (HTTP 403); check the token's observability:read scope and project role.`
                    : response.status === 404
                        ? `Neatlogs ${operation} returned HTTP 404; confirm the selected project and retry after ingestion.`
                        : response.status === 429
                            ? `Neatlogs ${operation} was rate limited (HTTP 429); retry after a short delay.`
                            : response.status >= 500
                                ? `Neatlogs ${operation} is temporarily unavailable (HTTP ${response.status}); retry later.`
                                : `Neatlogs ${operation} failed (HTTP ${response.status}).`;
            this.fail(detail);
            return null;
        }
        return response.json();
    }
}
//# sourceMappingURL=neatlogs-worker-traces.js.map