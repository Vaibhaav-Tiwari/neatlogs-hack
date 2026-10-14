import type { SizingSignals, SizingSignalsPort, TaskInput } from '../agent/ports.js';
import type { IntegrationState } from '../schema/types.js';
export interface CommandResult {
    stdout: string;
}
export interface CommandRunner {
    run(command: string, args: string[], options?: {
        cwd?: string;
    }): Promise<CommandResult>;
}
export interface EntireSizingOptions {
    repoPath: string;
    runner?: CommandRunner;
    topSymbols?: number;
    fallback?: SizingSignalsPort;
}
export declare class ShellCommandRunner implements CommandRunner {
    run(command: string, args: string[], options?: {
        cwd?: string;
    }): Promise<CommandResult>;
}
export declare class EntireSizingAdapter implements SizingSignalsPort {
    private readonly repoPath;
    private readonly runner;
    private readonly topSymbols;
    private readonly fallback;
    private readonly taskDetails;
    private graphStatus;
    constructor(options: EntireSizingOptions);
    signalsFor(task: TaskInput): Promise<SizingSignals | null>;
    status(): IntegrationState;
    detailFor(task: TaskInput): string | null;
    private entireGraphSignals;
    private repoRelative;
}
