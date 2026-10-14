import type { TallyConfig } from '../schema/index.js';
export interface VerifyInput {
    checkoutPath: string | null;
    branch?: string | null;
    repoPath?: string;
    config: TallyConfig;
}
export interface VerifyResult {
    passed: boolean;
    reason: string | null;
}
export interface VerifierPort {
    verify(input: VerifyInput): Promise<VerifyResult>;
}
export type ShellRunner = (command: string, options: {
    cwd: string;
    timeout?: number;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type WorktreeResolver = (repoPath: string, branch: string) => Promise<string | null>;
export type EntireVerifyRunner = (args: string[], options: {
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
}>;
export declare class CommandVerifier implements VerifierPort {
    private readonly run;
    private readonly resolveWorktree;
    constructor(run?: ShellRunner, resolveWorktree?: WorktreeResolver);
    verify(input: VerifyInput): Promise<VerifyResult>;
}
export declare function parseEntireVerifyVerdict(output: string, code: number): VerifyResult;
export declare class EntireGraphVerifier implements VerifierPort {
    private readonly fallback;
    private readonly runEntire;
    private readonly resolveWorktree;
    constructor(fallback?: CommandVerifier, runEntire?: EntireVerifyRunner, resolveWorktree?: WorktreeResolver);
    verify(input: VerifyInput): Promise<VerifyResult>;
}
