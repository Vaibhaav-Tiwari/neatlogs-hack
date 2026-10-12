import { loadEnv } from '../engine/env.js';
import { NANOS_PER_USD } from '../schema/money.js';
import type { IntegrationState, TaskSize } from '../schema/types.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistorySource, PriceHistoryWriterPort, PriceStats } from '../agent/ports.js';

export interface NeatlogsHistoryOptions {
  fallback: PriceHistoryPort & PriceHistoryWriterPort;
  env?: Record<string, string>;
  fetch?: typeof fetch;
  endpoint?: string;
  workflowName?: string;
  limit?: number;
  maxPages?: number;
}

interface Observation {
  size: TaskSize;
  tier: string;
  result: string;
  costNanos: number;
}

const DEFAULT_ENDPOINT = 'https://app.neatlogs.com/api/v1/public';
const DEFAULT_WORKFLOW = 'tally-cfo-agent';
const MAX_PAGE_SIZE = 50;
const MAX_PAGES = 10;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const nested = record.value;
  if (typeof nested === 'string') return nested;
  if (typeof record.stringValue === 'string') return record.stringValue;
  if (typeof record.intValue === 'number' || typeof record.intValue === 'string') return String(record.intValue);
  if (typeof record.doubleValue === 'number') return String(record.doubleValue);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = stringValue(value);
  if (text === null || text.trim() === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function attributesOf(span: unknown): Record<string, unknown> {
  if (typeof span !== 'object' || span === null) return {};
  const raw = (span as Record<string, unknown>).attributes;
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw
        .map((entry) => {
          if (typeof entry !== 'object' || entry === null) return null;
          const key = (entry as Record<string, unknown>).key;
          if (typeof key !== 'string') return null;
          return [key, (entry as Record<string, unknown>).value];
        })
        .filter((entry): entry is [string, unknown] => entry !== null),
    );
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

function traceIdOf(trace: unknown): string | null {
  if (typeof trace !== 'object' || trace === null) return null;
  const record = trace as Record<string, unknown>;
  return stringValue(record.id) ?? stringValue(record.traceId) ?? stringValue(record.trace_id);
}

function traceNameOf(trace: unknown): string | null {
  if (typeof trace !== 'object' || trace === null) return null;
  const record = trace as Record<string, unknown>;
  return stringValue(record.traceName) ?? stringValue(record.name);
}

function observationFromName(name: string | null): Observation | null {
  if (!name?.startsWith('tally.history.record ')) return null;
  const fields = Object.fromEntries(
    name
      .slice('tally.history.record '.length)
      .split(/\s+/)
      .map((part) => part.split('='))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== ''),
  );
  const size = fields.size;
  const tier = fields.tier;
  const result = fields.result;
  const costNanos = Number(fields.cost_nanos);
  if (size !== 'small' && size !== 'medium' && size !== 'large') return null;
  if (!tier || !result || !Number.isFinite(costNanos) || costNanos < 0) return null;
  return { size, tier, result, costNanos: Math.round(costNanos) };
}

function spansOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body !== 'object' || body === null) return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.spans)) return record.spans;
  if (Array.isArray(record.data)) return record.data;
  if (typeof record.data === 'object' && record.data !== null && Array.isArray((record.data as Record<string, unknown>).spans)) {
    return (record.data as Record<string, unknown>).spans as unknown[];
  }
  return [];
}

function tracesOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body !== 'object' || body === null) return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.traces)) return record.traces;
  if (Array.isArray(record.data)) return record.data;
  if (typeof record.data === 'object' && record.data !== null && Array.isArray((record.data as Record<string, unknown>).traces)) {
    return (record.data as Record<string, unknown>).traces as unknown[];
  }
  return [];
}

function pageOf(body: unknown): { hasMore: boolean; nextCursor: string | null } {
  if (typeof body !== 'object' || body === null) return { hasMore: false, nextCursor: null };
  const record = body as Record<string, unknown>;
  const data = typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : record;
  const rawPage = data.page ?? record.page;
  if (typeof rawPage !== 'object' || rawPage === null) return { hasMore: false, nextCursor: null };
  const page = rawPage as Record<string, unknown>;
  return {
    hasMore: page.hasMore === true,
    nextCursor: typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null,
  };
}

function observationFromSpan(span: unknown): Observation | null {
  if (typeof span !== 'object' || span === null) return null;
  const name = stringValue((span as Record<string, unknown>).name);
  const attrs = attributesOf(span);
  if (name !== 'tally.history.record' && stringValue(attrs['tally.history.kind']) !== 'attempt') return null;
  const size = stringValue(attrs['tally.history.size']) ?? stringValue(attrs.size);
  const tier = stringValue(attrs['tally.history.tier']) ?? stringValue(attrs.tier);
  const result = stringValue(attrs['tally.history.result']) ?? stringValue(attrs.result);
  const costNanos = numberValue(attrs['tally.history.cost_nanos']) ?? numberValue(attrs.costNanos);
  if (size !== 'small' && size !== 'medium' && size !== 'large') return null;
  if (!tier || !result || costNanos === null || costNanos < 0) return null;
  return { size, tier, result, costNanos: Math.round(costNanos) };
}

function aggregate(observations: Observation[], size: TaskSize, tier: string): PriceStats | null {
  const matches = observations.filter((row) => row.size === size && row.tier === tier && row.result !== 'error');
  if (matches.length === 0) return null;
  return {
    attempts: matches.length,
    passRate: matches.filter((row) => row.result === 'passed').length / matches.length,
    avgCostNanos: Math.round(matches.reduce((sum, row) => sum + row.costNanos, 0) / matches.length),
    successfulCostsNanos: matches.filter((row) => row.result === 'passed').map((row) => row.costNanos),
    source: 'neatlogs',
  };
}

export class NeatlogsPriceHistory implements PriceHistoryPort, PriceHistoryWriterPort {
  private readonly fallback: PriceHistoryPort & PriceHistoryWriterPort;
  private readonly token: string | null;
  private readonly projectId: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly workflowName: string;
  private readonly limit: number;
  private readonly maxPages: number;
  private readStatus: IntegrationState | null;
  private lastLookupSource: PriceHistorySource = 'none';

  constructor(options: NeatlogsHistoryOptions) {
    const env = options.env ?? loadEnv();
    this.fallback = options.fallback;
    this.token = env.NEATLOGS_TOKEN || null;
    this.projectId = env.NEATLOGS_PROJECT_ID || null;
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.workflowName = options.workflowName ?? DEFAULT_WORKFLOW;
    this.limit = boundedInteger(options.limit, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    this.maxPages = boundedInteger(options.maxPages, MAX_PAGES, MAX_PAGES);
    this.readStatus = this.token && this.projectId
      ? null
      : { status: 'missing', detail: 'NEATLOGS_TOKEN or NEATLOGS_PROJECT_ID is missing; using local price history.' };
  }

  status(): IntegrationState | null {
    return this.readStatus;
  }

  sourceOfLastLookup(): PriceHistorySource {
    return this.lastLookupSource;
  }

  async lookup(size: TaskSize, tier: string): Promise<PriceStats | null> {
    if (!this.token || !this.projectId) return this.fallbackLookup(size, tier);
    let remote: PriceStats | null;
    try {
      remote = aggregate(await this.remoteObservations(), size, tier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.readStatus = { status: 'error', detail: `Neatlogs price-history read failed; using local history. ${message}` };
      return this.fallbackLookup(size, tier);
    }
    if (remote) {
      this.readStatus = { status: 'ok', detail: null };
      this.lastLookupSource = 'neatlogs';
      return remote;
    }
    this.readStatus = { status: 'ok', detail: `No usable Neatlogs price-history observations matched ${size}/${tier}; using local history.` };
    return this.fallbackLookup(size, tier);
  }

  private async fallbackLookup(size: TaskSize, tier: string): Promise<PriceStats | null> {
    const stats = await this.fallback.lookup(size, tier);
    this.lastLookupSource = stats ? 'local' : 'none';
    return stats ? { ...stats, source: 'local' } : null;
  }

  async record(outcome: AttemptOutcome): Promise<void> {
    await this.fallback.record(outcome);
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, 'x-project-id': this.projectId! };
  }

  private async remoteObservations(): Promise<Observation[]> {
    const observations: Observation[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('neatlogs trace pagination returned a repeated cursor');
        seenCursors.add(cursor);
      }
      const tracesUrl = new URL(`${this.endpoint}/traces`);
      tracesUrl.searchParams.set('workflowName', this.workflowName);
      tracesUrl.searchParams.set('limit', String(this.limit));
      if (cursor) tracesUrl.searchParams.set('cursor', cursor);
      const tracesResponse = await this.fetchImpl(tracesUrl, { headers: this.headers() });
      if (!tracesResponse.ok) throw new Error(`neatlogs traces read failed: ${tracesResponse.status}`);
      const body = await tracesResponse.json();
      for (const trace of tracesOf(body)) {
        const traceName = traceNameOf(trace);
        const traceObservation = observationFromName(traceName);
        if (traceObservation) observations.push(traceObservation);
        if (traceName && traceName !== 'tally.history.record') continue;
        const traceId = traceIdOf(trace);
        if (!traceId) continue;
        const spansResponse = await this.fetchImpl(`${this.endpoint}/traces/${encodeURIComponent(traceId)}/spans`, { headers: this.headers() });
        if (!spansResponse.ok) throw new Error(`neatlogs spans read failed: ${spansResponse.status}`);
        for (const span of spansOf(await spansResponse.json())) {
          const observation = observationFromSpan(span);
          if (observation) observations.push(observation);
        }
      }
      const page = pageOf(body);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return observations;
  }
}

export function historyAttributes(outcome: AttemptOutcome): Record<string, string | number> {
  return {
    'tally.history.kind': 'attempt',
    'tally.history.size': outcome.size,
    'tally.history.tier': outcome.tier,
    'tally.history.result': outcome.result,
    'tally.history.cost_nanos': outcome.costNanos,
    'tally.history.cost_usd': outcome.costNanos / NANOS_PER_USD,
  };
}

export function historyTraceName(outcome: AttemptOutcome): string {
  return `tally.history.record size=${outcome.size} tier=${outcome.tier} result=${outcome.result} cost_nanos=${outcome.costNanos}`;
}
