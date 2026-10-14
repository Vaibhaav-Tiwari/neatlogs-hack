import type { BacklogTask } from '../engine/backlog.js';
import type { PrEvidenceLink } from '../engine/pr-evidence.js';
import type { TallyConfig } from '../schema/index.js';
export type PublishCommand = (file: string, args: string[], options?: {
    cwd?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export interface WorkerBranchInput {
    checkoutPath: string;
    branch: string;
    config: TallyConfig;
    baseCommit?: string | null;
}
export interface PublishPrInput extends WorkerBranchInput {
    task: BacklogTask;
    runId: string;
    attempt: number;
    scopeWarnings?: string[];
}
export interface UpdatePrEvidenceInput {
    config: TallyConfig;
    prUrl: string;
    links: PrEvidenceLink[];
}
export interface PublishPort {
    commitsAhead(input: WorkerBranchInput): Promise<number>;
    changedFiles(input: WorkerBranchInput): Promise<string[]>;
    publishPr(input: PublishPrInput): Promise<string>;
    updatePrEvidence?(input: UpdatePrEvidenceInput): Promise<void>;
}
export declare function replacePrEvidence(body: string, links: PrEvidenceLink[]): string;
export declare class GitHubPublisher implements PublishPort {
    private readonly command;
    constructor(command?: PublishCommand);
    changedFiles(input: WorkerBranchInput): Promise<string[]>;
    commitsAhead(input: WorkerBranchInput): Promise<number>;
    publishPr(input: PublishPrInput): Promise<string>;
    updatePrEvidence(input: UpdatePrEvidenceInput): Promise<void>;
    private pushCheckpoints;
}
