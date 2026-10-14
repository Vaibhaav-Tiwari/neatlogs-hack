import { type DoctorLine } from './doctor.js';
import { checkCfoaiConnection } from '../adapters/cfoai.js';
import { configureIntegrations } from '../onboarding/index.js';
import { readPlanBudget } from './plan.js';
export interface InitCommandResult {
    stdout: string;
    stderr: string;
}
export declare class InitError extends Error {
}
export type InitCommandRunner = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<InitCommandResult>;
export type PromptReader = (question: string, defaultValue?: string) => Promise<string>;
export interface InitOptions {
    cwd?: string;
    configPath?: string;
    command?: InitCommandRunner;
    readLine?: PromptReader;
    doctor?: (configPath: string) => Promise<DoctorLine[]>;
    print?: (line: string) => void;
    yes?: boolean;
    dryRun?: boolean;
    env?: Record<string, string>;
    cfoaiCheck?: typeof checkCfoaiConnection;
    onboarding?: typeof configureIntegrations;
    testCommand?: string;
    setupCommand?: string;
    budgetUsd?: number;
    issueLabel?: string;
    integrations?: Partial<Record<'neatlogs' | 'entire' | 'cfoai', boolean>>;
    verbose?: boolean;
    readBudget?: typeof readPlanBudget;
    runner?: 'ao' | 'direct';
    harnessChoice?: 'claude-code' | 'codex' | 'mixed';
    allowClaude?: boolean;
    modelAccessFallbackTier?: string;
}
export interface InitResult {
    applied: boolean;
    configPath: string;
    projectId: string;
    testCommand: string;
    setupCommand: string | null;
    baseBranch: string;
    tiers: string[];
    doctor: DoctorLine[];
}
export declare function defaultCommand(file: string, args: string[], options?: {
    cwd?: string;
    aoBin?: string;
}): Promise<InitCommandResult>;
export declare function defaultReadLine(question: string, defaultValue?: string): Promise<string>;
export declare function runInit(options?: InitOptions): Promise<InitResult>;
