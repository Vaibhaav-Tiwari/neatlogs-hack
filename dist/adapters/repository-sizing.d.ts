import type { SizingSignals, SizingSignalsPort, TaskInput } from '../agent/ports.js';
export interface RepositorySizingOptions {
    repoPath: string;
    listFiles?: () => Promise<string[]>;
    maxFiles?: number;
    maxFileBytes?: number;
    maxBytes?: number;
}
export declare function looksLikeTest(path: string): boolean;
export declare function issueIdentifiers(text: string): string[];
/** Local target evidence only: dependencies and runtime correctness require stronger evidence. */
export declare class RepositorySizingAdapter implements SizingSignalsPort {
    private readonly options;
    constructor(options: RepositorySizingOptions);
    signalsFor(task: TaskInput): Promise<SizingSignals | null>;
}
