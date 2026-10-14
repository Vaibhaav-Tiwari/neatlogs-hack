import { loadEnv } from '../engine/env.js';
import { NANOS_PER_USD } from '../schema/money.js';
const DEFAULT_ENDPOINT = 'https://app.neatlogs.com/api/v1/public';
const DEFAULT_WORKFLOW = 'tally-cfo-agent';
const MAX_PAGE_SIZE = 50;
const MAX_PAGES = 10;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const MAX_READ_TIMEOUT_MS = 120_000;
function boundedInteger(value, fallback, maximum) {
    return value !== undefined && Number.isFinite(value)
        ? Math.min(maximum, Math.max(1, Math.floor(value)))
        : fallback;
}
function stringValue(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const nested = record.value;
    if (typeof nested === 'string')
        return nested;
    if (typeof record.stringValue === 'string')
        return record.stringValue;
    if (typeof record.intValue === 'number' || typeof record.intValue === 'string')
        return String(record.intValue);
    if (typeof record.doubleValue === 'number')
        return String(record.doubleValue);
    return null;
}
function numberValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    const text = stringValue(value);
    if (text === null || text.trim() === '')
        return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}
function attributesOf(span) {
    if (typeof span !== 'object' || span === null)
        return {};
    const raw = span.attributes;
    if (Array.isArray(raw)) {
        return Object.fromEntries(raw
            .map((entry) => {
            if (typeof entry !== 'object' || entry === null)
                return null;
            const key = entry.key;
            if (typeof key !== 'string')
                return null;
            return [key, entry.value];
        })
            .filter((entry) => entry !== null));
    }
    return typeof raw === 'object' && raw !== null ? raw : {};
}
function traceIdOf(trace) {
    if (typeof trace !== 'object' || trace === null)
        return null;
    const record = trace;
    return stringValue(record.id) ?? stringValue(record.traceId) ?? stringValue(record.trace_id);
}
function traceNameOf(trace) {
    if (typeof trace !== 'object' || trace === null)
        return null;
    const record = trace;
    return stringValue(record.traceName) ?? stringValue(record.name);
}
function observationFromName(name) {
    if (!name?.startsWith('tally.history.record '))
        return null;
    const fields = Object.fromEntries(name
        .slice('tally.history.record '.length)
        .split(/\s+/)
        .map((part) => part.split('='))
        .filter((parts) => parts.length === 2 && parts[0] !== ''));
    const size = fields.size;
    const tier = fields.tier;
    const result = fields.result;
    const costNanos = Number(fields.cost_nanos);
    if (size !== 'small' && size !== 'medium' && size !== 'large')
        return null;
    if (!tier || !result || !Number.isFinite(costNanos) || costNanos < 0)
        return null;
    let model;
    try {
        model = fields.model ? decodeURIComponent(fields.model) : undefined;
    }
    catch {
        return null;
    }
    return { size, tier, ...(model ? { model } : {}), result, costNanos: Math.round(costNanos) };
}
function spansOf(body) {
    if (Array.isArray(body))
        return body;
    if (typeof body !== 'object' || body === null)
        return [];
    const record = body;
    if (Array.isArray(record.spans))
        return record.spans;
    if (Array.isArray(record.data))
        return record.data;
    if (typeof record.data === 'object' && record.data !== null && Array.isArray(record.data.spans)) {
        return record.data.spans;
    }
    return [];
}
function tracesOf(body) {
    if (Array.isArray(body))
        return body;
    if (typeof body !== 'object' || body === null)
        return [];
    const record = body;
    if (Array.isArray(record.traces))
        return record.traces;
    if (Array.isArray(record.data))
        return record.data;
    if (typeof record.data === 'object' && record.data !== null && Array.isArray(record.data.traces)) {
        return record.data.traces;
    }
    return [];
}
function pageOf(body) {
    if (typeof body !== 'object' || body === null)
        return { hasMore: false, nextCursor: null };
    const record = body;
    const data = typeof record.data === 'object' && record.data !== null
        ? record.data
        : record;
    const rawPage = data.page ?? record.page;
    if (typeof rawPage !== 'object' || rawPage === null)
        return { hasMore: false, nextCursor: null };
    const page = rawPage;
    return {
        hasMore: page.hasMore === true,
        nextCursor: typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null,
    };
}
function observationFromSpan(span) {
    if (typeof span !== 'object' || span === null)
        return null;
    const name = stringValue(span.spanName) ?? stringValue(span.name);
    const attrs = attributesOf(span);
    if (name !== 'tally.history.record' && stringValue(attrs['tally.history.kind']) !== 'attempt')
        return null;
    const size = stringValue(attrs['tally.history.size']) ?? stringValue(attrs.size);
    const tier = stringValue(attrs['tally.history.tier']) ?? stringValue(attrs.tier);
    const model = stringValue(attrs['tally.history.model']) ?? stringValue(attrs.model);
    const result = stringValue(attrs['tally.history.result']) ?? stringValue(attrs.result);
    const costNanos = numberValue(attrs['tally.history.cost_nanos']) ?? numberValue(attrs.costNanos);
    if (size !== 'small' && size !== 'medium' && size !== 'large')
        return null;
    if (!tier || !result || costNanos === null || costNanos < 0)
        return null;
    return { size, tier, ...(model ? { model } : {}), result, costNanos: Math.round(costNanos) };
}
function aggregate(observations, size, tier, model) {
    const matches = observations.filter((row) => row.size === size && row.tier === tier
        && (model ? row.model === model : row.model === undefined) && row.result !== 'error');
    if (matches.length === 0)
        return null;
    return {
        attempts: matches.length,
        passRate: matches.filter((row) => row.result === 'passed').length / matches.length,
        avgCostNanos: Math.round(matches.reduce((sum, row) => sum + row.costNanos, 0) / matches.length),
        successfulCostsNanos: matches.filter((row) => row.result === 'passed').map((row) => row.costNanos),
        source: 'neatlogs',
    };
}
export class NeatlogsPriceHistory {
    fallback;
    token;
    projectId;
    fetchImpl;
    endpoint;
    workflowName;
    limit;
    maxPages;
    timeoutMs;
    readStatus;
    lastLookupSource = 'none';
    observationsPromise = null;
    constructor(options) {
        const env = options.env ?? loadEnv();
        this.fallback = options.fallback;
        this.token = env.NEATLOGS_TOKEN || null;
        this.projectId = env.NEATLOGS_PROJECT_ID || null;
        this.fetchImpl = options.fetch ?? fetch;
        this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
        this.workflowName = options.workflowName ?? DEFAULT_WORKFLOW;
        this.limit = boundedInteger(options.limit, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
        this.maxPages = boundedInteger(options.maxPages, MAX_PAGES, MAX_PAGES);
        this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_READ_TIMEOUT_MS, MAX_READ_TIMEOUT_MS);
        this.readStatus = this.token && this.projectId
            ? null
            : { status: 'missing', detail: 'NEATLOGS_TOKEN or NEATLOGS_PROJECT_ID is missing; using local price history.' };
    }
    status() {
        return this.readStatus;
    }
    sourceOfLastLookup() {
        return this.lastLookupSource;
    }
    async lookup(size, tier, model) {
        if (!this.token || !this.projectId)
            return this.fallbackLookup(size, tier, model);
        let remote;
        try {
            this.observationsPromise ??= this.remoteObservations();
            remote = aggregate(await this.observationsPromise, size, tier, model);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.readStatus = { status: 'error', detail: `Neatlogs price-history read failed; using local history. ${message}` };
            return this.fallbackLookup(size, tier, model);
        }
        if (remote) {
            this.readStatus = { status: 'ok', detail: null };
            this.lastLookupSource = 'neatlogs';
            return remote;
        }
        this.readStatus = { status: 'ok', detail: `No usable Neatlogs price-history observations matched ${size}/${tier}${model ? ` model ${model} (unknown-model observations excluded)` : ''}; using local history.` };
        return this.fallbackLookup(size, tier, model);
    }
    async fallbackLookup(size, tier, model) {
        const stats = await this.fallback.lookup(size, tier, model);
        this.lastLookupSource = stats ? 'local' : 'none';
        return stats ? { ...stats, source: 'local' } : null;
    }
    async record(outcome) {
        await this.fallback.record(outcome);
    }
    headers() {
        return { Authorization: `Bearer ${this.token}`, 'x-project-id': this.projectId };
    }
    async remoteObservations() {
        const observations = [];
        const seenCursors = new Set();
        // One deadline covers all pages and span reads. A request-per-page timeout
        // could otherwise multiply into several minutes of silent plan latency.
        const signal = AbortSignal.timeout(this.timeoutMs);
        let cursor = null;
        for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
            if (cursor) {
                if (seenCursors.has(cursor))
                    throw new Error('neatlogs trace pagination returned a repeated cursor');
                seenCursors.add(cursor);
            }
            const tracesUrl = new URL(`${this.endpoint}/traces`);
            tracesUrl.searchParams.set('workflowName', this.workflowName);
            tracesUrl.searchParams.set('limit', String(this.limit));
            if (cursor)
                tracesUrl.searchParams.set('cursor', cursor);
            const tracesResponse = await this.fetchImpl(tracesUrl, { headers: this.headers(), signal });
            if (!tracesResponse.ok)
                throw new Error(`neatlogs traces read failed: ${tracesResponse.status}`);
            const body = await tracesResponse.json();
            for (const trace of tracesOf(body)) {
                const traceName = traceNameOf(trace);
                const traceObservation = observationFromName(traceName);
                if (traceObservation)
                    observations.push(traceObservation);
                // Older Tally history used the exact name and kept values in spans.
                // A missing traceName is not evidence that a trace is one of ours;
                // fetching spans for those rows turns a small list into hundreds of
                // unrelated sequential requests.
                if (traceName !== 'tally.history.record')
                    continue;
                const traceId = traceIdOf(trace);
                if (!traceId)
                    continue;
                const spansResponse = await this.fetchImpl(`${this.endpoint}/traces/${encodeURIComponent(traceId)}/spans`, { headers: this.headers(), signal });
                if (!spansResponse.ok)
                    throw new Error(`neatlogs spans read failed: ${spansResponse.status}`);
                for (const span of spansOf(await spansResponse.json())) {
                    const observation = observationFromSpan(span);
                    if (observation)
                        observations.push(observation);
                }
            }
            const page = pageOf(body);
            if (!page.hasMore || !page.nextCursor)
                break;
            cursor = page.nextCursor;
        }
        return observations;
    }
}
export function historyAttributes(outcome) {
    return {
        'tally.history.kind': 'attempt',
        'tally.history.size': outcome.size,
        'tally.history.tier': outcome.tier,
        ...(outcome.model ? { 'tally.history.model': outcome.model } : {}),
        'tally.history.result': outcome.result,
        'tally.history.cost_nanos': outcome.costNanos,
        'tally.history.cost_usd': outcome.costNanos / NANOS_PER_USD,
    };
}
export function historyTraceName(outcome) {
    return `tally.history.record size=${outcome.size} tier=${outcome.tier} result=${outcome.result} cost_nanos=${outcome.costNanos}${outcome.model ? ` model=${encodeURIComponent(outcome.model)}` : ''}`;
}
//# sourceMappingURL=neatlogs-history.js.map