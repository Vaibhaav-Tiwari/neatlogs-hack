import type { CheckpointRecall, CheckpointRecallPort, TaskInput } from '../agent/ports.js';
import type { IntegrationState } from '../schema/types.js';
export interface CommandResult {
    stdout: string;
}
export type CommandRunner = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<CommandResult>;
export interface EntireRecallOptions {
    repoPath: string;
    command?: CommandRunner;
    limit?: number;
}
export declare class EntireCheckpointRecallAdapter implements CheckpointRecallPort {
    private readonly command;
    private readonly repoPath;
    private readonly limit;
    private availability;
    constructor(options: EntireRecallOptions);
    status(): IntegrationState;
    checkAvailability(): Promise<IntegrationState>;
    private search;
    recallFor(task: TaskInput): Promise<CheckpointRecall | null>;
}
