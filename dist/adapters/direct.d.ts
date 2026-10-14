import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';
import type { TallyConfig } from '../schema/index.js';
import type { CommandRunner } from './ao.js';
/** API message ids deduplicate the full content-block and partial-event views. */
export declare class ClaudeUsageMeter {
    private readonly messages;
    private current;
    private final;
    consume(value: unknown): void;
    private merge;
    usage(): LiveUsage | null;
}
export declare function checkDirectHarness(harness: string, command?: CommandRunner): Promise<void>;
export declare function requireClaudeConsent(approvedRules: string[] | undefined, test?: TallyConfig['test']): asserts approvedRules is string[];
export declare function claudeArguments(input: WorkerStartInput, sessionId: string, approvedRules: string[]): string[];
/** Commits a finished direct worker's edits on its branch, leaving out ignored and Tally-owned files. Shared by every direct harness. */
export declare function commitWorkerEdits(command: CommandRunner, session: {
    checkoutPath: string;
    branch: string;
}, repo: {
    repoPath: string;
    configPath?: string;
}): Promise<string | null>;
export interface DirectRunnerOptions {
    repoPath: string;
    baseBranch: string;
    requiredBaseCommit?: string;
    test: TallyConfig['test'];
    approvedRules?: string[];
    configPath?: string;
    command?: CommandRunner;
    launch?: (file: string, args: string[], options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        detached: boolean;
        stdio: 'pipe';
    }) => ChildProcessWithoutNullStreams;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
    stopGraceMs?: number;
    /** A stopped session started by another harness's runner, so this one can continue its branch. */
    adopt?: (sessionId: string) => Pick<Session, 'branch' | 'checkoutPath' | 'directory' | 'closed'> | undefined;
}
interface Session {
    child: ChildProcessWithoutNullStreams;
    branch: string;
    checkoutPath: string;
    directory: string;
    meter: ClaudeUsageMeter;
    completion: Promise<void>;
    closed: boolean;
    stopped: boolean;
    error: string | null;
    denied: boolean;
    permissionWarnings: string[];
}
export declare class DirectRunner implements WorkerPort, LiveUsagePort, SessionControlPort {
    private readonly options;
    private readonly sessions;
    private readonly command;
    constructor(options: DirectRunnerOptions);
    start(input: WorkerStartInput): Promise<{
        sessionId: string;
        branch: string;
        checkoutPath: string;
        setupDurationMs: number;
    }>;
    continuation(id: string): Pick<Session, 'branch' | 'checkoutPath' | 'directory' | 'closed'> | undefined;
    private session;
    wait(id: string, options?: {
        timeoutMs?: number;
    }): Promise<WorkerResult>;
    usageFor(id: string): Promise<LiveUsage | null>;
    settledUsageFor(id: string): Promise<LiveUsage | null>;
    stop(id: string, _reason: string): Promise<void>;
    commitChanges(id: string): Promise<string | null>;
    /** Called only after verification, publishing and capture have read the checkout. Stopped branches remain for continuation. */
    release(id: string): Promise<void>;
}
export {};
