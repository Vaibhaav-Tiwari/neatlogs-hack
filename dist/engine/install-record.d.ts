import type { AoHarnessPermissionModes } from './harness.js';
export interface InstallRecord {
    version: 1;
    runner?: 'ao' | 'direct';
    configPath: string;
    configHash: string;
    projectId: string;
    projectCreated: boolean;
    projectConfigHash: string;
    postCreateExisted: boolean;
    postCreateAfterHash: string;
    addedSetupCommand: string | null;
    workerExisted?: boolean;
    workerBefore?: unknown;
    workerAfterHash?: string;
    workerPermissionMode?: 'auto' | 'default';
    aoHarnessPermissions?: AoHarnessPermissionModes;
}
export declare function installRecordPath(configPath: string): string;
export declare function contentHash(value: string): string;
export declare function configHash(value: unknown): string;
