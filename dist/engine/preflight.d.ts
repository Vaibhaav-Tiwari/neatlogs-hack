import type { TallyConfig } from '../schema/index.js';
export type PreflightRunner = (file: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function repoPath(config: TallyConfig, configPath: string): string;
export declare function backlogPath(config: TallyConfig, configPath: string): string | null;
export declare function withWorkerAutoMode(config: unknown): Record<string, unknown>;
export declare function aoWorkerMode(config: Pick<TallyConfig, 'tiers'>): 'default' | 'auto';
export declare function withWorkerPermissionMode(config: unknown, mode: 'default' | 'auto'): Record<string, unknown>;
export declare function workerAutoModeFixCommand(projectId: string, projectConfig: unknown): string;
export declare function workerPermissionMode(projectConfig: unknown): string | null;
export interface WorkerPermissionCheck {
    ok: boolean;
    mode: string | null;
    detail: string;
    fix: string;
}
export declare function checkWorkerAutoMode(projectId: string, projectConfig: unknown): WorkerPermissionCheck;
export declare function checkConfiguredWorkerMode(config: TallyConfig, projectConfig: unknown): WorkerPermissionCheck;
export declare function checkClaudePostCreate(config: TallyConfig, configPath: string, projectConfig: unknown): SetupPostCreateCheck | null;
export declare function setupPostCreateFixCommand(projectId: string, projectConfig: unknown, setupCommand: string): string;
export interface SetupPostCreateCheck {
    ok: boolean;
    detail: string;
    fix: string;
}
export declare function checkSetupPostCreate(projectId: string, projectConfig: unknown, setupCommand: string | undefined): SetupPostCreateCheck | null;
export declare function validateRealRunConfig(config: TallyConfig, configPath: string, runner?: PreflightRunner): Promise<void>;
