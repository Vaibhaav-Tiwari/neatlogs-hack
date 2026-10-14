import { type FailureTracePort } from '../agent/failure.js';
import type { BudgetPort, CheckpointRecallPort, CheckpointPort, HandoffPort, LiveUsagePort, PriceHistoryPort, PriceHistoryWriterPort, SessionControlPort, SizingSignalsPort, TracePort } from '../agent/ports.js';
import { buildCfoaiTaskContext } from '../adapters/cfoai-context.js';
import { type WorkerTraceDrainPort } from '../adapters/neatlogs-worker-spool.js';
import { type WorkerTraceReaderPort } from '../adapters/neatlogs-worker-traces.js';
import { type BacklogIntakePort } from '../adapters/github.js';
import { type PublishPort } from '../adapters/publisher.js';
import { type VerifierPort } from '../adapters/verifier.js';
import type { IntegrationState, Tier } from '../schema/index.js';
import { type BacklogTask } from './backlog.js';
import { type RunOptions, type RunResult } from './run.js';
export interface WorkerStartInput {
    task: BacklogTask;
    attempt: number;
    tier: Tier;
    ceilingNanos: number | null;
    harness: string;
    sessionMode?: 'chat' | 'tui';
    model: string;
    name: string;
    prompt: string;
    aoProject?: string;
    continueBranch?: string | null;
    continueSessionId?: string | null;
}
export interface WorkerResult {
    status: 'idle' | 'terminated' | 'needs_input' | 'timeout' | 'experiment_stop' | 'never_started' | 'error';
    branch: string | null;
    checkoutPath: string | null;
    prUrl: string | null;
    resultReason?: string | null;
    permissionWarnings?: string[];
}
export interface WorkerPort {
    start(input: WorkerStartInput): Promise<{
        sessionId: string;
        branch: string | null;
        checkoutPath: string | null;
        setupDurationMs?: number;
    }>;
    wait(sessionId: string, options?: {
        timeoutMs?: number;
    }): Promise<WorkerResult>;
    /** Optional scripted evidence, read only once this attempt has settled. */
    changedFilesFor?(sessionId: string): Promise<string[] | null>;
    release?(sessionId: string): Promise<void>;
    /** Host commits uncommitted task edits after normal direct-worker completion. */
    commitChanges?(sessionId: string): Promise<string | null>;
}
export interface FinalUsagePort extends LiveUsagePort {
    settledUsageFor?(sessionId: string): Promise<Awaited<ReturnType<LiveUsagePort['usageFor']>>>;
}
export interface WorktreePort {
    checkoutPathFor(repoPath: string, branch: string): Promise<string | null>;
    commitFor?(repoPath: string, branch: string): Promise<string | null>;
    commitWorkInProgress?(repoPath: string, branch: string): Promise<string | null>;
}
export interface CfoaiBudgetPort extends BudgetPort {
    budgetLimitNanos(): Promise<number>;
    currentSpendNanos?(): Promise<number>;
    writeCumulativeActualSpend(runSpendNanos: number): Promise<void>;
    writeSpendDetail?(input: {
        attempts: Array<{
            tier: string;
            costNanos: number;
        }>;
        cumulativeRunSpendNanos: number;
    }): Promise<{
        skippedTiers: string[];
    }>;
    publishTaskContext?(document: ReturnType<typeof buildCfoaiTaskContext>): Promise<void>;
    status(): IntegrationState;
    tableUrl?(): string | undefined;
}
export interface RealRunPorts {
    workerTraceDrain?: WorkerTraceDrainPort;
    workerTraceReader?: WorkerTraceReaderPort & Partial<FailureTracePort>;
    failureTrace?: FailureTracePort;
    intake: BacklogIntakePort;
    signals: SizingSignalsPort;
    worker: WorkerPort;
    verifier: VerifierPort;
    usage: LiveUsagePort;
    sessions: SessionControlPort;
    history: PriceHistoryPort & PriceHistoryWriterPort;
    recall?: CheckpointRecallPort;
    handoff?: HandoffPort;
    checkpoints?: CheckpointPort;
    trace?: TracePort;
    cfoai?: CfoaiBudgetPort;
    publisher: PublishPort;
    worktrees: WorktreePort;
}
export interface RealRunOptions extends RunOptions {
    ports?: Partial<RealRunPorts>;
}
export declare class GitWorktreeResolver implements WorktreePort {
    commitWorkInProgress(repoPath: string, branch: string): Promise<string | null>;
    commitFor(repoPath: string, branch: string): Promise<string | null>;
    checkoutPathFor(repoPath: string, branch: string): Promise<string | null>;
}
export declare function runRealTally(options: RealRunOptions): Promise<RunResult>;
