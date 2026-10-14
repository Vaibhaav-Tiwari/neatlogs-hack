export declare const COMMANDS: readonly ['run', 'demo', 'dashboard', 'init', 'uninstall', 'doctor', 'login', 'market', 'publish', 'experiment', 'traces', 'logo'];
export type Command = (typeof COMMANDS)[number];
export declare const VERSION = "0.2.1";
export interface CliOptions {
    /** Path to tally.yaml. */
    config: string;
    /** Simulated workers with scripted outcomes; spends nothing. */
    dryRun: boolean;
    /** Send every task to the strongest tier, for the before/after comparison. */
    baseline: boolean;
    /** Overrides the budget in tally.yaml. */
    budgetUsd: number | undefined;
    parallel?: number;
    /** Run a single task by id or issue number. */
    only: string | undefined;
    /** Start the local dashboard server before execution. */
    dashboard: boolean;
    open?: boolean;
    /** Port for the dashboard server. */
    port: number | undefined;
    /** Print route decisions without spawning workers. */
    plan: boolean;
    /** Use live read-only integrations for `tally demo`. */
    live: boolean;
    yes?: boolean;
    testCommand?: string;
    setupCommand?: string;
    issueLabel?: string;
    verbose?: boolean;
    integrations?: Partial<Record<'neatlogs' | 'entire' | 'cfoai', boolean>>;
    runner?: 'ao' | 'direct';
    harnessChoice?: 'claude-code' | 'codex' | 'mixed';
    allowClaude?: boolean;
    modelAccessFallbackTier?: string;
    repeats?: number;
    /** Integration to authenticate for `tally login`. */
    loginTarget: 'cfoai' | undefined;
    /** Directory for `tally market` output. */
    output: string | undefined;
    /** CrustData result limit for `tally market`. */
    limit: number | undefined;
    /** Keyword for `tally market`. */
    keyword: string | undefined;
    replay?: string;
    review?: string;
    maxCredits?: number;
    jobs?: boolean;
    secondary?: string;
    out?: string;
    runs?: string[];
    runId?: string;
}
export type ParsedCli = {
    kind: 'command';
    command: Command;
    options: CliOptions;
} | {
    kind: 'help';
} | {
    kind: 'version';
} | {
    kind: 'error';
    message: string;
};
export interface CliIO {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
}
export declare function parseCli(argv: string[]): ParsedCli;
/** Returns the process exit code. */
export declare function main(argv: string[], io?: CliIO): Promise<number>;
