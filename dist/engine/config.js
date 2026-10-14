import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../schema/index.js';
export class ConfigError extends Error {
    path;
    problems;
    constructor(path, problems) {
        super(`${path}: ${problems.join('; ')}`);
        this.path = path;
        this.problems = problems;
        this.name = 'ConfigError';
    }
}
/** Reads and validates tally.yaml. Everything about the target repository comes from here. */
export function loadConfig(path) {
    if (!existsSync(path))
        throw new ConfigError(path, ['file not found; run `tally init` to create it']);
    let parsed;
    try {
        parsed = parseYaml(readFileSync(path, 'utf8'));
    }
    catch (e) {
        throw new ConfigError(path, [`not valid YAML: ${e.message}`]);
    }
    const result = validateConfig(parsed);
    if (!result.ok)
        throw new ConfigError(path, result.errors);
    return parsed;
}
//# sourceMappingURL=config.js.map