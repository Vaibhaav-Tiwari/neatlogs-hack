import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';
import type { TallyConfig, TokenUsage } from '../schema/index.js';
import type { CommandRunner } from './ao.js';
import { type DirectRunnerOptions } from './direct.js';
/** Codex reports input including cache reads, and output including reasoning. */
export declare function codexTokens(value: unknown): TokenUsage;
export declare class CodexRolloutError extends Error {
}
/**
 * The latest cumulative `token_count` in one session's rollout file. Null when
 * the session has reported none yet. A final line still being appended is
 * skipped; any other unreadable line throws, because spend cannot be trusted then.
 */
export declare function rolloutUsage(text: string): TokenUsage | null;
/**
 * The exact flags for one unattended worker. Workspace-write confined to the
 * worktree plus one scratch directory, no network, never asks for approval,
 * and never a bypass or full-access mode.
 */
export declare function codexArguments(input: {
    model: string;
    checkoutPath: string;
    scratchPath: string;
}): string[];
export interface CodexDirectOptions {
    repoPath: string;
    baseBranch: string;
    requiredBaseCommit?: string;
    configPath?: string;
    test: TallyConfig['test'];
    command?: CommandRunner;
    launch?: (file: string, args: string[], options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        detached: boolean;
        stdio: 'pipe';
    }) => ChildProcessWithoutNullStreams;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
    stopGraceMs?: number;
    /** Where Codex keeps its session files. Defaults to $CODEX_HOME or ~/.codex. */
    codexHome?: string;
    /** How long Codex may take to announce its session before the start is abandoned. */
    threadStartMs?: number;
    /** How long a running session may go without a rollout file before spend is called unmeterable. */
    rolloutGraceMs?: number;
    /** A stopped session started by another harness's runner, so this one can continue its branch. */
    adopt?: (sessionId: string) => Continuation | undefined;
    now?: () => number;
}
/** What a later attempt needs from the attempt it continues. */
export interface Continuation {
    branch: string;
    checkoutPath: string;
    directory: string;
    closed: boolean;
}
/** Runs Codex itself, one worker per attempt, in a worktree Tally owns. */
export declare class CodexDirectRunner implements WorkerPort, LiveUsagePort, SessionControlPort {
    private readonly options;
    private readonly sessions;
    private readonly command;
    private readonly now;
    constructor(options: CodexDirectOptions);
    continuation(sessionId: string): Continuation | undefined;
    start(input: WorkerStartInput): Promise<{
        sessionId: string;
        branch: string;
        checkoutPath: string;
        setupDurationMs: number;
    }>;
    private session;
    /** Looks only for the rollout file named after this session's own id. */
    private findRollout;
    private meter;
    /** Unmeterable spend ends the worker rather than letting it run uncapped. */
    private meterOrStop;
    usageFor(id: string): Promise<LiveUsage | null>;
    /** After exit: the larger of the final rollout total and the usage Codex printed on its completed turns. */
    settledUsageFor(id: string): Promise<LiveUsage | null>;
    wait(id: string, options?: {
        timeoutMs?: number;
    }): Promise<WorkerResult>;
    /** Ends the worker's whole process group: SIGTERM, then SIGKILL after the grace period. */
    stop(id: string, _reason: string): Promise<void>;
    /** The sandbox cannot write git metadata, so Tally commits the finished worker's edits itself. */
    commitChanges(id: string): Promise<string | null>;
    /** Called only after verification, publishing and capture have read the checkout. Stopped branches remain for continuation. */
    release(id: string): Promise<void>;
}
/** Missing or signed-out Codex stops the run. No other harness is ever used in its place. */
export declare function checkCodex(command?: CommandRunner): Promise<void>;
type DirectPorts = WorkerPort & LiveUsagePort & SessionControlPort & {
    settledUsageFor(sessionId: string): Promise<LiveUsage | null>;
    commitChanges(sessionId: string): Promise<string | null>;
    release(sessionId: string): Promise<void>;
};
/** Sends each attempt to the runner for its tier's harness, and every later call to the runner that started the session. */
export declare class DirectHarnessRouter implements WorkerPort, LiveUsagePort, SessionControlPort {
    private readonly runners;
    private readonly owners;
    constructor(runners: Record<string, DirectPorts>);
    private owner;
    start(input: WorkerStartInput): Promise<{
        sessionId: string;
        branch: string | null;
        checkoutPath: string | null;
        setupDurationMs?: number;
    }>;
    wait(sessionId: string, options?: {
        timeoutMs?: number;
    }): Promise<WorkerResult>;
    usageFor(sessionId: string): Promise<LiveUsage | null>;
    settledUsageFor(sessionId: string): Promise<LiveUsage | null>;
    stop(sessionId: string, reason: string): Promise<void>;
    commitChanges(sessionId: string): Promise<string | null>;
    release(sessionId: string): Promise<void>;
}
/** The direct runner for a config: Claude Code and Codex side by side, each able to continue the other's stopped branch. */
export declare function createDirectRunner(options: DirectRunnerOptions): DirectHarnessRouter;
export {};
