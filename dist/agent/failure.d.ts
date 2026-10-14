import type { AttemptResult, FailureAssessment } from '../schema/types.js';
export type { FailureAssessment, FailureKind } from '../schema/types.js';
export interface FailureSpan {
    id: string;
    name: string;
    type: string;
    status: string;
    error?: string;
    startedAt?: string;
}
export interface FailureTraceContext {
    runId: string;
    taskId: string;
    attempt: number;
    traceId?: string | null;
}
export interface FailureTracePort {
    failureFor(context: FailureTraceContext): Promise<{
        traceId: string;
        spans: FailureSpan[];
    } | null>;
}
export interface FailureAttempt {
    attemptId: string;
    taskId: string;
    attempt: number;
    result: AttemptResult;
    resultReason?: string | null;
    workerTraceId?: string | null;
}
export declare function diagnoseAttempt(previous: FailureAttempt, port?: FailureTracePort): Promise<FailureAssessment>;
