import type { TallyConfig } from '../schema/index.js';
import { type BacklogTask } from '../engine/backlog.js';
export type GithubCommand = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export interface BacklogIntakePort {
    tasks(config: TallyConfig, configPath: string): Promise<BacklogTask[]>;
}
export interface GithubRetryOptions {
    sleep?: (ms: number) => Promise<void>;
    print?: (line: string) => void;
    now?: () => number;
}
export declare class GithubIssueIntake implements BacklogIntakePort {
    private readonly command;
    private readonly retry;
    constructor(command?: GithubCommand, retry?: GithubRetryOptions);
    private read;
    tasks(config: TallyConfig, _configPath: string): Promise<BacklogTask[]>;
}
export declare class ConfigBacklogIntake implements BacklogIntakePort {
    private readonly github?;
    constructor(github?: GithubIssueIntake | undefined);
    tasks(config: TallyConfig, configPath: string): Promise<BacklogTask[]>;
}
