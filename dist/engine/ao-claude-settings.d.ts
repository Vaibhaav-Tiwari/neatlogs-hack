type Command = (file: string, args: string[], options: {
    cwd: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
/** AO runs postCreate before launching the harness. Use the root's trusted config. */
export declare function aoClaudeSetupCommand(configPath: string): string;
export interface AoClaudeSettingsOptions {
    configPath: string;
    worktreePath?: string;
    scriptRoot?: string;
    command?: Command;
    runSetup?: boolean;
}
export interface AoClaudeSettingsResult {
    installed: boolean;
    settingsPath?: string;
    testScript?: string;
    setupScript?: string;
}
export declare function installAoClaudeSettings(options: AoClaudeSettingsOptions): Promise<AoClaudeSettingsResult>;
export {};
