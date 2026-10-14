import { TraceExporter } from '@neatlogs/codex';
import type { IntegrationState } from '../schema/types.js';
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
export declare class NeatlogsWorkerSpoolAdapter implements WorkerTraceDrainPort {
    private state;
    private readonly root;
    private readonly exporter;
    constructor(options?: {
        root?: string;
        env?: Record<string, string>;
        exporter?: Exporter;
        maxBatches?: number;
        lockWaitMs?: number;
        lockIsOpen?: (path: string) => Promise<boolean>;
    });
    private readonly maxBatches;
    private readonly lockWaitMs;
    private readonly lockIsOpen;
    private waitForLock;
    status(): IntegrationState;
    drainWorker(context: WorkerTraceContext): Promise<void>;
    private drain;
}
export {};
