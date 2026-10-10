import { loadEnv } from '../engine/env.js';
import { NANOS_PER_USD } from '../schema/money.js';
import type { TaskSize } from '../schema/types.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistoryWriterPort, PriceStats } from '../agent/ports.js';

export interface NeatlogsHistoryOptions {
  fallback: PriceHistoryPort & PriceHistoryWriterPort;
  env?: Record<string, string>;
  fetch?: typeof fetch;
  endpoint?: string;
  workflowName?: string;
  limit?: number;
}

interface Observation {
  size: TaskSize;
  tier: string;
  result: string;
  costNanos: number;
}

const DEFAULT_ENDPOINT = 'https://app.neatlogs.com/api/v1/public';
const DEFAULT_WORKFLOW = 'tally-cfo-agent';

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

  constructor(options: NeatlogsHistoryOptions) {
    const env = options.env ?? loadEnv();
    this.fallback = options.fallback;
    this.token = env.NEATLOGS_TOKEN || null;
    this.projectId = env.NEATLOGS_PROJECT_ID || null;
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.workflowName = options.workflowName ?? DEFAULT_WORKFLOW;
    this.limit = options.limit ?? 100;
  }

  async lookup(size: TaskSize, tier: string): Promise<PriceStats | null> {
    if (!this.token || !this.projectId) return this.fallback.lookup(size, tier);
    try {
      const remote = aggregate(await this.remoteObservations(), size, tier);
      return remote ?? this.fallback.lookup(size, tier);
    } catch {
      return this.fallback.lookup(size, tier);
    }
  }

  async record(outcome: AttemptOutcome): Promise<void> {
    await this.fallback.record(outcome);
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, 'x-project-id': this.projectId! };
  }

  private async remoteObservations(): Promise<Observation[]> {
    const tracesUrl = new URL(`${this.endpoint}/traces`);
    tracesUrl.searchParams.set('workflowName', this.workflowName);
    tracesUrl.searchParams.set('limit', String(this.limit));
    const tracesResponse = await this.fetchImpl(tracesUrl, { headers: this.headers() });
    if (!tracesResponse.ok) throw new Error(`neatlogs traces read failed: ${tracesResponse.status}`);
    const traces = tracesOf(await tracesResponse.json());
    const observations: Observation[] = [];
    for (const trace of traces) {
      const traceName = traceNameOf(trace);
      const traceObservation = observationFromName(traceName);
      if (traceObservation) observations.push(traceObservation);
      if (traceName && traceName !== 'tally.history.record') continue;
      const traceId = traceIdOf(trace);
      if (!traceId) continue;
      const spansResponse = await this.fetchImpl(`${this.endpoint}/traces/${encodeURIComponent(traceId)}/spans`, { headers: this.headers() });
      if (!spansResponse.ok) continue;
      for (const span of spansOf(await spansResponse.json())) {
        const observation = observationFromSpan(span);
        if (observation) observations.push(observation);
      }
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
