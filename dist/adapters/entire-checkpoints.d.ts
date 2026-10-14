import type { CheckpointInfo, CheckpointPort, HandoffContext, HandoffPort, HandoffSummary } from '../agent/ports.js';
export interface CommandResult {
    stdout: string;
    stderr: string;
}
export type CommandRunner = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<CommandResult>;
export interface EntireCheckpointOptions {
    repoPath: string;
    repoSlug?: string;
    command?: CommandRunner;
    summaryTimeoutSec?: number;
    generatedSummaries?: boolean;
}
export declare class EntireCheckpointAdapter implements HandoffPort, CheckpointPort {
    private readonly command;
    private readonly repoPath;
    private readonly summaryTimeoutSec;
    private readonly generatedSummaries;
    private readonly repoSlug?;
    private mirrorReadyPromise?;
    constructor(options: EntireCheckpointOptions);
    checkpointFor(context: HandoffContext & {
        sessionId: string;
    }): Promise<CheckpointInfo | null>;
    sessionIdFor(context: HandoffContext & {
        sessionId: string;
    }): Promise<string | null>;
    summaryFor(sessionId: string, context?: HandoffContext): Promise<HandoffSummary | null>;
    private findCheckpoint;
    private sessionInfo;
    private checkpointList;
    private explain;
    private hasReadyMirror;
}
