import type { Ledger, RunState } from '../schema/index.js';
export declare const DEFAULT_LATEST_RUN_DIR = ".tally/runs/latest";
export interface WrittenRunFiles {
    outputDir: string;
    runStatePath: string;
    ledgerPath: string;
    latestRunDir: string;
}
export declare function writeRunFiles(outputDir: string, runState: RunState, ledger: Ledger, latestRunDir?: string): WrittenRunFiles;
