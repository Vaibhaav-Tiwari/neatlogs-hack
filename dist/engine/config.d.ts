import { type TallyConfig } from '../schema/index.js';
export declare class ConfigError extends Error {
    readonly path: string;
    readonly problems: string[];
    constructor(path: string, problems: string[]);
}
/** Reads and validates tally.yaml. Everything about the target repository comes from here. */
export declare function loadConfig(path: string): TallyConfig;
