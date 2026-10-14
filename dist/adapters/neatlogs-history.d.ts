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
    /** Maximum wall time for loading the remote history snapshot. */
    timeoutMs?: number;
}
export declare class NeatlogsPriceHistory implements PriceHistoryPort, PriceHistoryWriterPort {
    private readonly fallback;
    private readonly token;
    private readonly projectId;
    private readonly fetchImpl;
    private readonly endpoint;
    private readonly workflowName;
    private readonly limit;
    private readonly maxPages;
    private readonly timeoutMs;
    private readStatus;
    private lastLookupSource;
    private observationsPromise;
    constructor(options: NeatlogsHistoryOptions);
    status(): IntegrationState | null;
    sourceOfLastLookup(): PriceHistorySource;
    lookup(size: TaskSize, tier: string, model?: string): Promise<PriceStats | null>;
    private fallbackLookup;
    record(outcome: AttemptOutcome): Promise<void>;
    private headers;
    private remoteObservations;
}
export declare function historyAttributes(outcome: AttemptOutcome): Record<string, string | number>;
export declare function historyTraceName(outcome: AttemptOutcome): string;
