import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';
export interface CommandResult {
    stdout: string;
    stderr: string;
}
export type CommandRunner = (file: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}) => Promise<CommandResult>;
export interface AoAdapterOptions {
    aoBin?: string;
    requiredBaseCommit?: string;
    project?: string;
    cwd?: string;
    command?: CommandRunner;
    fetch?: typeof fetch;
    usageBaseUrl?: string;
    pollMs?: number;
    idleStablePolls?: number;
    needsInputGracePolls?: number;
    usageSettlePolls?: number;
    usageSettleMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    startupTimeoutMs?: number;
}
export declare function usageFromAoPayload(payload: unknown): LiveUsage | null;
export declare class AoCliAdapter implements WorkerPort, LiveUsagePort, SessionControlPort {
    private readonly options;
    private readonly stoppedSessions;
    private readonly command;
    private readonly fetchImpl;
    private readonly usageBaseUrl;
    private readonly pollMs;
    private readonly idleStablePolls;
    private readonly needsInputGracePolls;
    private readonly usageSettlePolls;
    private readonly usageSettleMs;
    private readonly sleep;
    private readonly exitedAgents;
    constructor(options?: AoAdapterOptions);
    start(input: WorkerStartInput): Promise<{
        sessionId: string;
        branch: string | null;
        checkoutPath: string | null;
    }>;
    private spawnWithPermissions;
    private checkoutFor;
    private continueAttempt;
    wait(sessionId: string, options?: {
        timeoutMs?: number;
    }): Promise<WorkerResult>;
    usageFor(sessionId: string): Promise<LiveUsage | null>;
    settledUsageFor(sessionId: string): Promise<LiveUsage | null>;
    stop(sessionId: string, _reason: string): Promise<void>;
    private exitAgent;
    commitChanges(sessionId: string): Promise<string | null>;
    private session;
    private resultFrom;
}
