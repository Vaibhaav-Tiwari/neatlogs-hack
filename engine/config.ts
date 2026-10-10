import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateConfig, type TallyConfig } from '../schema/index.js';

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`${path}: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/** Reads and validates tally.yaml. Everything about the target repository comes from here. */
export function loadConfig(path: string): TallyConfig {
  if (!existsSync(path)) throw new ConfigError(path, ['file not found; run `tally init` to create it']);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(path, [`not valid YAML: ${(e as Error).message}`]);
  }
  const result = validateConfig(parsed);
  if (!result.ok) throw new ConfigError(path, result.errors);
  return parsed as TallyConfig;
}
