/**
 * Everything the CFO agent needs from the outside world.
 *
 * The agent never calls a tool directly. The engine passes in an
 * implementation of each port (lane A's adapters for real runs, the fakes in
 * `agent/testing/fakes.ts` for tests and dry runs). Every port may be slow or
 * fail; the agent treats a thrown error or a null as "not available" and
 * falls back to a safe default instead of failing the run.
 */
import type { AttemptResult, CostSource, Handoff, IntegrationState, TaskImpact, TaskSize, TokenUsage } from '../schema/types.js';
/** The part of a backlog item the agent reads. */
export interface TaskInput {
    taskId: string;
    title: string;
    /** The issue text. May be empty. */
    body: string;
}
/** Where the sizing numbers came from, weakest last. */
export type SignalSource = TaskImpact['source'];
export interface SizingSignals {
    /** Files the change is expected to touch. */
    filesTouched: number;
    /** Other files or symbols that depend on the touched ones. */
    dependents: number;
    /** Whether tests already exist for the touched area. */
    testsPresent: boolean;
    source: SignalSource;
    impact?: TaskImpact;
    /** Related search hits, never counted as files the task must edit. */
    contextFiles?: string[];
    /** Repository-only evidence: new targets are not mistaken for missing measurements. */
    scope?: {
        existingFiles: string[];
        newFiles: string[];
        createOnly: boolean;
        namedTargets: number;
        truncated: boolean;
    };
}
export interface SizingSignalsPort {
    /** Task-specific availability or fallback detail, without changing sizing numbers. */
    detailFor?(task: TaskInput): string | null;
    /** Null when nothing could be measured for this task. */
    signalsFor(task: TaskInput): Promise<SizingSignals | null>;
}
export interface CheckpointRecall {
    checkpointId: string;
    checkpointUrl: string | null;
    summary: string;
    files: string[];
    failed: boolean;
}
export interface CheckpointRecallPort {
    /** Searches past agent checkpoints for work on the same area. */
    recallFor(task: TaskInput): Promise<CheckpointRecall | null>;
    status?(): IntegrationState;
}
/** What has actually been observed for one (task size, tier, model) identity. No prior mixed in. */
export interface PriceStats {
    /** Attempts that ended passed, failed or stopped. */
    attempts: number;
    /** Share of those attempts that passed, in [0, 1]. */
    passRate: number;
    avgCostNanos: number;
    /** Uncensored costs from successful attempts, for percentile-based caps. */
    successfulCostsNanos?: number[];
    source?: PriceHistorySource;
}
export type PriceHistorySource = 'neatlogs' | 'local' | 'none';
export interface PriceHistoryPort {
    /** Null, or attempts = 0, when there is no history for the pair. */
    /** A model-specific lookup must never include observations with an unknown/different model. */
    lookup(size: TaskSize, tier: string, model?: string): Promise<PriceStats | null>;
    /** Optional status for remote history adapters; local adapters can omit it. */
    status?(): IntegrationState | null;
    /** Source that supplied the most recent result; `none` means no observations matched. */
    sourceOfLastLookup?(): PriceHistorySource;
}
/** One finished attempt, as the history needs it. */
export interface AttemptOutcome {
    size: TaskSize;
    /** Tier name from tally.yaml. */
    tier: string;
    /** Actual configured model from the ended ledger row; absent only on legacy observations. */
    model?: string;
    result: AttemptResult;
    costNanos: number;
}
export interface PriceHistoryWriterPort {
    record(outcome: AttemptOutcome): Promise<void>;
}
export interface BudgetPort {
    /**
     * Budget that is free to commit right now: the limit, minus what has been
     * spent, minus the ceilings of attempts that are still running.
     */
    remainingNanos(): Promise<number>;
}
export interface LiveUsage {
    tokens: TokenUsage;
    /** The Agent Orchestrator's own estimate; used only when no list price applies. */
    estimatedCostNanos: number;
}
export interface LiveUsagePort {
    /** Null when the session has reported no usage yet. */
    usageFor(sessionId: string): Promise<LiveUsage | null>;
}
export interface SessionControlPort {
    stop(sessionId: string, reason: string): Promise<void>;
}
export interface HandoffSummary {
    /** Which mechanism produced the summary. Recorded on the escalated ledger row. */
    type: Exclude<Handoff, 'none' | 'restart'>;
    summary: string;
    /** Entire checkpoint evidence for the failed attempt, when available. */
    checkpointId?: string | null;
    checkpointUrl?: string | null;
    /** Branch the stronger model should continue from. */
    branch?: string | null;
    /** Cost of generating this summary, if the provider reports it. */
    summaryCostNanos?: number;
    summaryCostSource?: CostSource;
    summaryTokens?: TokenUsage;
}
export interface HandoffContext {
    branch?: string | null;
    checkoutPath?: string | null;
    checkpointId?: string | null;
    task?: TaskInput;
    result?: AttemptResult;
    resultReason?: string | null;
    changedFiles?: string[];
}
export interface HandoffPort {
    /** Null when no summary exists; the escalation then restarts from the issue. */
    summaryFor(sessionId: string, context?: HandoffContext): Promise<HandoffSummary | null>;
}
export interface CheckpointInfo {
    checkpointId: string;
    checkpointUrl: string | null;
    entireSessionId?: string | null;
}
export interface CheckpointPort {
    checkpointFor(context: HandoffContext & {
        sessionId: string;
    }): Promise<CheckpointInfo | null>;
    /** Native capture session may exist before any checkpoint or task commit. */
    sessionIdFor?(context: HandoffContext & {
        sessionId: string;
    }): Promise<string | null>;
}
export interface LlmRequest {
    /** Model id on the gateway. Omit to use the port's default. */
    model?: string;
    system?: string;
    prompt: string;
    maxTokens?: number;
}
export interface LlmResponse {
    text: string;
}
export interface LlmPort {
    complete(request: LlmRequest): Promise<LlmResponse>;
}
export type TraceValue = string | number | boolean | null;
export type TraceAttributes = Record<string, TraceValue>;
export interface TraceSpan {
    /** Adds attributes to the span, e.g. the decision once it is known. */
    set(attributes: TraceAttributes): void;
}
export interface TracePort {
    /** Runs `fn` inside one trace span. Must return or rethrow whatever `fn` does. */
    span<T>(name: string, attributes: TraceAttributes, fn: (span: TraceSpan) => Promise<T>): Promise<T>;
}
