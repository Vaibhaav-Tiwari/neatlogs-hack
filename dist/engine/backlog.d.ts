import { type AttemptResult, type Handoff, type TaskImpact, type TaskSize, type TallyConfig, type TokenUsage } from '../schema/index.js';
export interface ScriptedAttempt {
    tier?: string;
    result: AttemptResult;
    resultReason: string | null;
    tokens: TokenUsage;
    handoff: Exclude<Handoff, 'none'> | null;
    decision: string | null;
    changedFiles?: string[];
}
export interface BacklogTask {
    taskId: string;
    title: string;
    body: string;
    issueNumber: number | null;
    issueUrl: string | null;
    size: TaskSize;
    /** Scripted attempt outcomes for dry runs. Defaults to one passed attempt. */
    outcomes: AttemptResult[];
    /** Richer dry-run script, when the backlog provides one. */
    scriptedAttempts?: ScriptedAttempt[];
    /** Deliberate first-attempt ceiling for demos; escalation uses normal tier ceilings. */
    firstAttemptCeilingUsd?: number;
    impact?: TaskImpact;
}
export declare class BacklogError extends Error {
    readonly path: string;
    readonly problems: string[];
    constructor(path: string, problems: string[]);
}
/** Reads the file fallback backlog. GitHub issue intake will plug in beside this adapter. */
export declare function loadFileBacklog(config: TallyConfig, configPath: string): BacklogTask[];
