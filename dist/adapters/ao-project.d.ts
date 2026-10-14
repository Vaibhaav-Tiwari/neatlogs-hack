/** Read/write the full daemon config; the CLI mirror omits fields such as effort. */
export declare function aoProjectCommand(args: string[], fetchImpl?: typeof fetch): Promise<{
    stdout: string;
    stderr: string;
}>;
