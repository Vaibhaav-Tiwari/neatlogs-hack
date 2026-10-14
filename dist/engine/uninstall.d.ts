import { type InitCommandRunner, type PromptReader } from './init.js';
export interface UninstallOptions {
    configPath?: string;
    command?: InitCommandRunner;
    readLine?: PromptReader;
    print?: (line: string) => void;
}
export declare function runUninstall(options?: UninstallOptions): Promise<{
    removed: boolean;
    items: string[];
}>;
