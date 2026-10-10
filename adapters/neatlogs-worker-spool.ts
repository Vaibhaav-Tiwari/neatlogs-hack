import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRuntimeRoot, SpanSpool, TraceExporter } from '@neatlogs/codex';
import type { IntegrationState } from '../schema/types.js';
import { loadEnv } from '../engine/env.js';

export interface WorkerTraceContext {
  checkoutPath: string | null;
  entireSessionId?: string | null;
}

export interface WorkerTraceDrainPort {
  drainWorker(context: WorkerTraceContext): Promise<void>;
  status?(): IntegrationState;
}

interface Exporter {
  exportSpans: TraceExporter['exportSpans'];
}

interface QueuedSpan {
  attributes?: Array<{ key: string; value: { stringValue?: string } }>;
}

function attribute(span: QueuedSpan, key: string): string | undefined {
  return span.attributes?.find((entry) => entry.key === key)?.value.stringValue;
}

export class NeatlogsWorkerSpoolAdapter implements WorkerTraceDrainPort {
  private state: IntegrationState = { status: 'ok', detail: null };
  private readonly root: string;
  private readonly exporter: Exporter | null;

  constructor(options: { root?: string; env?: Record<string, string>; exporter?: Exporter; maxBatches?: number } = {}) {
    const env = options.env ?? loadEnv();
    this.root = options.root ?? getRuntimeRoot(process.env);
    this.exporter = options.exporter ?? (env.NEATLOGS_API_KEY ? new TraceExporter({ apiKey: env.NEATLOGS_API_KEY, endpoint: env.NEATLOGS_ENDPOINT ?? 'https://ingest.neatlogs.com', timeoutMs: 5000 }) : null);
    this.maxBatches = options.maxBatches ?? 128;
  }

  private readonly maxBatches: number;

  status(): IntegrationState { return this.state; }

  async drainWorker(context: WorkerTraceContext): Promise<void> {
    if (!this.exporter) {
      this.state = { status: 'missing', detail: 'Worker traces cannot drain: NEATLOGS_API_KEY is missing.' };
      return;
    }
    const spool = new SpanSpool(this.root);
    const batches = spool.pendingFiles().flatMap((path) => {
      try {
        const batch = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; spans?: QueuedSpan[] };
        return batch.version === 1 && Array.isArray(batch.spans) ? [{ path, spans: batch.spans }] : [];
      } catch { return []; }
    });
    const sessions = new Set(context.entireSessionId ? [context.entireSessionId] : []);
    for (const batch of batches) for (const span of batch.spans) {
      const cwd = attribute(span, 'neatlogs.workflow.cwd');
      const id = attribute(span, 'neatlogs.session.id');
      if (id && cwd && context.checkoutPath && resolve(cwd) === resolve(context.checkoutPath)) sessions.add(id);
    }
    const selected = new Set(batches.filter((batch) => batch.spans.some((span) => {
      const id = attribute(span, 'neatlogs.session.id');
      return id !== undefined && sessions.has(id);
    })).map((batch) => batch.path));
    if (!selected.size) return;
    // Keep the SDK's shared lock and acknowledgement logic, but drain only this worker.
    const pendingFiles = spool.pendingFiles.bind(spool);
    spool.pendingFiles = () => pendingFiles().filter((path) => selected.has(path));
    const exporter = this.exporter;
    const result = await spool.drain({ exportSpans: async (spans, workflow) => {
      // Even terminal failures must retain the batch; only delivery success acknowledges it.
      return await exporter.exportSpans(spans, workflow) === 'success' ? 'success' : 'retryable';
    } }, this.maxBatches);
    this.state = result.retained > 0
      ? { status: 'missing', detail: `Worker traces pending: ${result.retained} batch(es) retained${result.skipped ? ' (another drain holds the lock)' : ''}; retry from Tally outside the worker sandbox.` }
      : { status: 'ok', detail: null };
  }
}
