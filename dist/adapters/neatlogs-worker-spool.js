import { readFileSync, statSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getRuntimeRoot, SpanSpool, TraceExporter } from '@neatlogs/codex';
import { loadEnv } from '../engine/env.js';
const execFileAsync = promisify(execFile);
async function lockIsOpen(path) {
    try {
        const result = await execFileAsync('lsof', ['-t', path], { timeout: 2000 });
        return result.stdout.trim() !== '';
    }
    catch (error) {
        const result = error;
        // Exit 1 with no diagnostic means no open descriptors, not an inspection failure.
        return !(result.code === 1 && !result.stderr?.trim());
    }
}
function attribute(span, key) {
    return span.attributes?.find((entry) => entry.key === key)?.value.stringValue;
}
export class NeatlogsWorkerSpoolAdapter {
    state = { status: 'ok', detail: null };
    root;
    exporter;
    constructor(options = {}) {
        const env = options.env ?? loadEnv();
        this.root = options.root ?? getRuntimeRoot(process.env);
        this.exporter = options.exporter ?? (env.NEATLOGS_API_KEY ? new TraceExporter({ apiKey: env.NEATLOGS_API_KEY, endpoint: env.NEATLOGS_ENDPOINT ?? 'https://ingest.neatlogs.com', timeoutMs: 15000 }) : null);
        this.maxBatches = options.maxBatches ?? 128;
        // The SDK exporter can hold the shared drain lock through its 15 second
        // network timeout. Wait past that bound before reporting contention.
        this.lockWaitMs = options.lockWaitMs ?? 20000;
        this.lockIsOpen = options.lockIsOpen ?? lockIsOpen;
    }
    maxBatches;
    lockWaitMs;
    lockIsOpen;
    async waitForLock(path, deadline) {
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
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return true;
                throw error;
            }
            if (Date.now() >= deadline)
                return false;
            await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
    }
    status() { return this.state; }
    async drainWorker(context) {
        try {
            await this.drain(context);
        }
        catch (error) {
            const name = error instanceof Error ? error.name : 'unknown error';
            this.state = { status: 'missing', detail: `Worker trace drain failed (${name}); queued data was retained. Retry with \`tally traces drain\` outside the worker sandbox.` };
        }
    }
    async drain(context) {
        if (!this.exporter) {
            this.state = { status: 'missing', detail: 'Worker traces cannot drain: NEATLOGS_API_KEY is missing.' };
            return;
        }
        const spool = new SpanSpool(this.root);
        const batches = spool.pendingFiles().flatMap((path) => {
            try {
                const batch = JSON.parse(readFileSync(path, 'utf8'));
                return batch.version === 1 && Array.isArray(batch.spans) ? [{ path, spans: batch.spans }] : [];
            }
            catch {
                return [];
            }
        });
        const sessions = new Set(context.entireSessionId ? [context.entireSessionId] : []);
        for (const batch of batches)
            for (const span of batch.spans) {
                const cwd = attribute(span, 'neatlogs.workflow.cwd');
                const id = attribute(span, 'neatlogs.session.id');
                if (id && cwd && context.checkoutPath && resolve(cwd) === resolve(context.checkoutPath))
                    sessions.add(id);
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
        let heartbeat;
        let exportFailure = null;
        let result = { sent: 0, dropped: 0, retained: selected.size, skipped: true };
        try {
            do {
                if (!(await this.waitForLock(lockPath, deadline)))
                    break;
                result = await spool.drain({ exportSpans: async (spans, workflow) => {
                        if (!heartbeat) {
                            const inode = statSync(lockPath).ino;
                            // Host drains can exceed the SDK's 30-second lease; keep our live lock fresh.
                            heartbeat = setInterval(() => {
                                try {
                                    if (statSync(lockPath).ino === inode)
                                        utimesSync(lockPath, new Date(), new Date());
                                }
                                catch { /* SDK release or another owner replaced the lock. */ }
                            }, 5000);
                        }
                        // Even terminal failures must retain the batch; only delivery success acknowledges it.
                        try {
                            const exported = await exporter.exportSpans(spans, workflow);
                            if (exported !== 'success') {
                                exportFailure = exported === 'terminal'
                                    ? 'Neatlogs rejected a worker batch; the spool kept it for inspection and retry.'
                                    : 'Neatlogs did not acknowledge a worker batch; the spool kept it for retry.';
                                return 'retryable';
                            }
                            return 'success';
                        }
                        catch (error) {
                            const name = error instanceof Error ? error.name : 'unknown error';
                            exportFailure = `Neatlogs export failed (${name}); the spool kept the worker batch for retry.`;
                            return 'retryable';
                        }
                    } }, this.maxBatches);
            } while (result.skipped && Date.now() < deadline);
        }
        finally {
            if (heartbeat)
                clearInterval(heartbeat);
        }
        this.state = result.retained > 0
            ? { status: 'missing', detail: [
                    `Worker traces pending: ${result.retained} batch(es) retained`,
                    result.skipped ? 'another drain holds the lock; the 20 second wait expired' : null,
                    exportFailure,
                    'retry with `tally traces drain` outside the worker sandbox',
                ].filter((detail) => Boolean(detail)).join('; ') }
            : { status: 'ok', detail: null };
    }
}
//# sourceMappingURL=neatlogs-worker-spool.js.map