import { type InstallRecord } from './install-record.js';
import type { InitCommandRunner } from './init.js';
export interface InitTransaction {
    version: 1;
    repoRoot: string;
    configPath: string;
    configText: string;
    beforeProjectConfigHash: string;
    newProjectInitialized?: boolean;
    completed?: string[];
    record: InstallRecord;
}
export declare function pendingInitPath(configPath: string): string;
export declare function readPendingInit(configPath: string): InitTransaction | null;
export declare function applyInitTransaction(transaction: InitTransaction, command: InitCommandRunner, recordPath: string): Promise<void>;
export declare function finishInitTransaction(configPath: string): void;
