/** Keep unrelated dotenv lines; refuse symlinks and multiline values. */
export declare function saveSecrets(values: Record<string, string>, path?: string): void;
/** No visible readline output, masking characters, telemetry or secret-bearing errors. */
export declare function readHiddenSecret(question: string, options?: {
    input?: typeof process.stdin;
    output?: typeof process.stdout;
}): Promise<string | null>;
