import type { CostSource, Tier, TokenUsage } from '../schema/types.js';
import type { LiveUsage, LiveUsagePort, SessionControlPort, TracePort } from './ports.js';
export interface WatchedAttempt {
    sessionId: string;
    /** The tier running the attempt; its list price turns tokens into cost. */
    tier: Tier;
    /** Null means no ceiling (baseline mode); the attempt is never stopped. */
    ceilingNanos: number | null;
}
export interface CeilingCheck {
    costNanos: number;
    costSource: CostSource;
    tokens: TokenUsage | null;
    crossed: boolean;
}
export interface WatchVerdict extends CeilingCheck {
    action: 'continue' | 'stop';
    /** Ledger `resultReason` for a stopped attempt; null while the attempt may continue. */
    reason: string | null;
    /** False when a stop was needed but the session could not be stopped. */
    stopped: boolean;
    /** False when the usage could not be read on this poll, so the cost is unknown. */
    usageReadable: boolean;
}
export interface WatchOptions {
    intervalMs?: number;
    /** Abort when the attempt ends on its own. */
    signal?: AbortSignal;
    /** Replaceable so tests do not wait. */
    sleep?: (ms: number) => Promise<void>;
}
/** Cost is tokens x list price. The orchestrator's estimate is used only when the tier has no price. */
export declare function checkCeiling(usage: LiveUsage | null, attempt: WatchedAttempt): CeilingCheck;
export declare class CeilingWatcher {
    private readonly ports;
    constructor(ports: {
        usage: LiveUsagePort;
        sessions: SessionControlPort;
        trace?: TracePort;
    });
    /** Reads usage once and stops the session if it has crossed its ceiling. */
    poll(attempt: WatchedAttempt): Promise<WatchVerdict>;
    /** Polls until the session has been stopped at its ceiling or the signal is aborted. */
    watch(attempt: WatchedAttempt, options?: WatchOptions): Promise<WatchVerdict>;
}
