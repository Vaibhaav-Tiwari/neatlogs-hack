import type { IntegrationState } from '../schema/types.js';
import type { TraceAttributes, TracePort, TraceSpan, TraceValue } from '../agent/ports.js';
export interface NeatlogsSdk {
    init(options: {
        apiKey: string;
        workflowName: string;
        tags?: string[];
    }): Promise<unknown> | unknown;
    trace<T>(options: {
        name: string;
        kind: 'CHAIN';
        sessionId?: string;
        input?: unknown;
        attributes?: Record<string, TraceValue>;
    }, fn: () => Promise<T>): Promise<T>;
    injectTraceContext?(carrier: Record<string, string>): void;
    flush?(): Promise<void> | void;
    shutdown?(): Promise<void> | void;
}
export interface NeatlogsTraceOptions {
    workflowName?: string;
    tags?: string[];
    env?: Record<string, string>;
    sdk?: NeatlogsSdk | null;
    loadSdk?: () => Promise<NeatlogsSdk>;
}
export declare class NeatlogsTraceAdapter implements TracePort {
    private readonly apiKey;
    private readonly workflowName;
    private readonly tags;
    private readonly sdkOverride;
    private readonly loadSdk;
    private sdk;
    private initStarted;
    private offReason;
    private lastTraceIdValue;
    private decisionIds;
    constructor(options?: NeatlogsTraceOptions);
    status(): IntegrationState;
    lastTraceId(runId?: string, taskId?: string, attempt?: number): string | null;
    span<T>(name: string, attributes: TraceAttributes, fn: (span: TraceSpan) => Promise<T>): Promise<T>;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    private ready;
    private initialise;
}
