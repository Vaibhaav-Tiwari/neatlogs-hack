/** Secrets live outside every repository so they cannot be committed. */
export declare function defaultEnvPath(): string;
/**
 * Reads KEY=VALUE lines from the secrets file. Empty values are treated as
 * unset. Values are returned to the caller and never logged.
 */
export declare function loadEnv(path?: string): Record<string, string>;
/** Which of the named secrets are present. Safe to print. */
export declare function secretStatus(env: Record<string, string>, names: string[]): Record<string, 'set' | 'missing'>;
