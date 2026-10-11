import { readFileSync, statSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

async function lockIsOpen(path: string): Promise<boolean> {
  try {
    const result = await execFileAsync('lsof', ['-t', path], { timeout: 2000 });
    return result.stdout.trim() !== '';
  } catch (error) {
    const result = error as { code?: number; stderr?: string };
    // Exit 1 with no diagnostic means no open descriptors, not an inspection failure.
    return !(result.code === 1 && !result.stderr?.trim());
  }
}

function attribute(span: QueuedSpan, key: string): string | undefined {
  return span.attributes?.find((entry) => entry.key === key)?.value.stringValue;
}

export class NeatlogsWorkerSpoolAdapter implements WorkerTraceDrainPort {
  private state: IntegrationState = { status: 'ok', detail: null };
  private readonly root: string;
  private readonly exporter: Exporter | null;

  constructor(options: { root?: string; env?: Record<string, string>; exporter?: Exporter; maxBatches?: number; lockWaitMs?: number; lockIsOpen?: (path: string) => Promise<boolean> } = {}) {
    const env = options.env ?? loadEnv();
    this.root = options.root ?? getRuntimeRoot(process.env);
    this.exporter = options.exporter ?? (env.NEATLOGS_API_KEY ? new TraceExporter({ apiKey: env.NEATLOGS_API_KEY, endpoint: env.NEATLOGS_ENDPOINT ?? 'https://ingest.neatlogs.com', timeoutMs: 15000 }) : null);
    this.maxBatches = options.maxBatches ?? 128;
    this.lockWaitMs = options.lockWaitMs ?? 5000;
    this.lockIsOpen = options.lockIsOpen ?? lockIsOpen;
  }

  private readonly maxBatches: number;
  private readonly lockWaitMs: number;
  private readonly lockIsOpen: (path: string) => Promise<boolean>;

  private async waitForLock(path: string, deadline: number): Promise<boolean> {
    while (true) {
      try {
        const before = statSync(path);
        if (Date.now() - before.mtimeMs > 30000 && !(await this.lockIsOpen(path))) {
          const after = statSync(path);
          if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) {
            rmSync(path);
            return true;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      }
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }

  status(): IntegrationState { return this.state; }

  async drainWorker(context: WorkerTraceContext): Promise<void> {
    try {
      await this.drain(context);
    } catch {
      this.state = { status: 'missing', detail: 'Worker trace drain failed; queued data was retained. Retry outside the worker sandbox.' };
    }
  }

  private async drain(context: WorkerTraceContext): Promise<void> {
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
    if (!selected.size) {
      this.state = { status: 'missing', detail: 'No queued worker trace found; delivery is not verified (hooks may be absent or another exporter already drained it).' };
      return;
    }
    // Keep the SDK's shared lock and acknowledgement logic, but drain only this worker.
    const pendingFiles = spool.pendingFiles.bind(spool);
    spool.pendingFiles = () => pendingFiles().filter((path) => selected.has(path));
    const exporter = this.exporter;
    const lockPath = join(this.root, 'spool', 'drain.lock');
    const deadline = Date.now() + this.lockWaitMs;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let result = { sent: 0, dropped: 0, retained: selected.size, skipped: true };
    try {
      do {
        if (!(await this.waitForLock(lockPath, deadline))) break;
        result = await spool.drain({ exportSpans: async (spans, workflow) => {
          if (!heartbeat) {
            const inode = statSync(lockPath).ino;
            // Host drains can exceed the SDK's 30-second lease; keep our live lock fresh.
            heartbeat = setInterval(() => {
              try {
                if (statSync(lockPath).ino === inode) utimesSync(lockPath, new Date(), new Date());
              } catch { /* SDK release or another owner replaced the lock. */ }
            }, 5000);
          }
          // Even terminal failures must retain the batch; only delivery success acknowledges it.
          return await exporter.exportSpans(spans, workflow).catch(() => 'retryable' as const) === 'success' ? 'success' : 'retryable';
        } }, this.maxBatches);
      } while (result.skipped && Date.now() < deadline);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    this.state = result.retained > 0
      ? { status: 'missing', detail: `Worker traces pending: ${result.retained} batch(es) retained${result.skipped ? ' (another drain holds the lock)' : ''}; retry from Tally outside the worker sandbox.` }
      : { status: 'ok', detail: null };
  }
}
