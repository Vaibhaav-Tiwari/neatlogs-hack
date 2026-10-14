import type { IntegrationState } from '../schema/types.js';
import type { FailureSpan, FailureTraceContext, FailureTracePort } from '../agent/failure.js';
export interface WorkerTraceReadContext {
    runId: string;
    taskId: string;
    attempt: number;
    nativeSessionId?: string | null;
    traceId?: string | null;
}
export interface WorkerTraceReaderPort {
    verifyFor(context: WorkerTraceReadContext): Promise<string | null>;
    status?(): IntegrationState;
}
export declare class NeatlogsWorkerTraceReader implements WorkerTraceReaderPort, FailureTracePort {
    private readonly env;
    private readonly fetchImpl;
    private readonly endpoint;
    private readonly retries;
    private readonly retryDelayMs;
    private state;
    constructor(options?: {
        env?: Record<string, string>;
        fetch?: typeof fetch;
        endpoint?: string;
        retries?: number;
        retryDelayMs?: number;
    });
    status(): IntegrationState;
    failureFor(context: FailureTraceContext): Promise<{
        traceId: string;
        spans: FailureSpan[];
    } | null>;
    private fail;
    private readFailureSpans;
    verifyFor(context: WorkerTraceReadContext): Promise<string | null>;
    private discover;
    private read;
}
