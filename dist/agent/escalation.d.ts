/**
 * Escalation: what happens after an attempt fails or is stopped at its
 * ceiling. The task moves one tier up, once, if the budget allows, and the
 * stronger tier is given the earlier attempt's handoff summary when there is
 * one.
 */
import type { AttemptResult, CostSource, Handoff, TallyConfig, TaskSize, Tier, TokenUsage } from '../schema/types.js';
import type { BudgetPort, HandoffPort, PriceHistoryPort, TaskInput, TraceAttributes, TracePort } from './ports.js';
import { type HistoryPlan } from './history-plan.js';
import { type FailureAssessment, type FailureTracePort } from './failure.js';
/** The attempt that just ended, as written on its ledger row. */
export interface FinishedAttempt {
    attemptId: string;
    taskId: string;
    /** 1 for the first attempt, 2 for the escalation. */
    attempt: number;
    size: TaskSize;
    /** Tier name from tally.yaml. */
    tier: string;
    result: AttemptResult;
    /** Null for simulated attempts. */
    sessionId: string | null;
    branch?: string | null;
    checkpointId?: string | null;
    resultReason?: string | null;
    workerTraceId?: string | null;
}
export interface EscalateDecision {
    action: 'escalate';
    taskId: string;
    size: TaskSize;
    attempt: 2;
    tier: Tier;
    ceilingNanos: number;
    /** attemptId of the attempt being taken over. */
    escalatedFrom: string;
    /** Goes on the escalated ledger row. */
    handoff: Exclude<Handoff, 'none'>;
    /** Text to give the stronger tier; null when it restarts from the issue. */
    handoffSummary: string | null;
    handoffBranch?: string | null;
    handoffSummaryCostNanos: number;
    handoffSummaryCostSource: CostSource;
    handoffSummaryTokens: TokenUsage;
    checkpointId: string | null;
    checkpointUrl: string | null;
    history?: HistoryPlan;
    /** One plain-English sentence for the dashboard and the ledger row. */
    reason: string;
}
export interface GiveUpDecision {
    action: 'give-up';
    taskId: string;
    /** Goes into TaskState.statusReason. Null when the attempt passed and nothing is wrong. */
    statusReason: string | null;
    reason: string;
}
export type EscalationDecision = EscalateDecision | GiveUpDecision;
export interface EscalationInput {
    previous: FinishedAttempt;
    task?: TaskInput;
    config: TallyConfig;
    ports: {
        budget: BudgetPort;
        handoff?: HandoffPort;
        trace?: TracePort;
        history?: PriceHistoryPort;
        failureTrace?: FailureTracePort;
    };
    failureAssessment?: FailureAssessment;
    traceAttributes?: TraceAttributes;
}
export declare function decideEscalation(input: EscalationInput): Promise<EscalationDecision>;
