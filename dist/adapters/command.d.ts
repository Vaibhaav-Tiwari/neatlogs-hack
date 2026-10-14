export declare class CommandError extends Error {
    readonly code?: string | number | undefined;
    readonly stdout: string;
    readonly stderr: string;
    constructor(message: string, code?: string | number | undefined, stdout?: string, stderr?: string);
}
export interface AoBinaryOptions {
    aoBin?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    home?: string;
    bundleRoots?: string[];
}
export declare function resolveAoBinary(options?: AoBinaryOptions): string;
/** Resolve Entire's standard user-local install location even when the shell PATH omits it. */
export declare function resolveEntireBinary(options?: Pick<AoBinaryOptions, 'platform' | 'home'>): string;
export declare function runCommand(file: string, args: string[], options?: AoBinaryOptions & {
    timeout?: number;
    maxBuffer?: number;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
