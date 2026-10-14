import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Secrets live outside every repository so they cannot be committed. */
export function defaultEnvPath() {
    return join(homedir(), '.tally', '.env');
}
/**
 * Reads KEY=VALUE lines from the secrets file. Empty values are treated as
 * unset. Values are returned to the caller and never logged.
 */
export function loadEnv(path = defaultEnvPath()) {
    if (!existsSync(path))
        return {};
    const env = {};
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#'))
            continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match)
            continue;
        const value = match[2].replace(/^(["'])(.*)\1$/, '$2');
        if (value !== '')
            env[match[1]] = value;
    }
    return env;
}
/** Which of the named secrets are present. Safe to print. */
export function secretStatus(env, names) {
    return Object.fromEntries(names.map((name) => [name, env[name] ? 'set' : 'missing']));
}
//# sourceMappingURL=env.js.map