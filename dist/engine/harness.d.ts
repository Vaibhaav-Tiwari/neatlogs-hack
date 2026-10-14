import type { Tier } from '../schema/types.js';
import type { InitCommandRunner } from './init.js';
export type Harness = Tier['harness'];
export declare const AO_HARNESS_PERMISSIONS: {
    readonly codex: 'auto';
    readonly 'claude-code': 'default';
};
export type AoHarnessPermissionModes = Partial<Record<Harness, 'auto' | 'default'>>;
export interface HarnessStatus {
    harness: Harness;
    installed: boolean;
    signedIn: boolean;
    detail: string;
    fix: string;
}
/** CLI-owned status only: never inspect credential files or invoke inference. */
export declare function checkHarness(harness: Harness, command: InitCommandRunner, cwd?: string): Promise<HarnessStatus>;
export declare function claudeAllowList(test: {
    command: string;
    setupCommand?: string;
}): string[];
export declare function claudeScripts(test: {
    command: string;
    setupCommand?: string;
}): Array<{
    name: 'test' | 'setup';
    contents: string;
    rule: string;
}>;
export declare function requireClaudeScriptConsent(allow: string[] | undefined, test: {
    command: string;
    setupCommand?: string;
}): asserts allow is string[];
