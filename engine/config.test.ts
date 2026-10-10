import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const sample = fileURLToPath(new URL('../schema/fixtures/finished-run/tally.yaml', import.meta.url));

describe('loadConfig', () => {
  it('loads and validates a tally.yaml', () => {
    const config = loadConfig(sample);
    expect(config.test.command).toBe('npm test');
    expect(config.tiers.map((t) => t.name)).toEqual(['cheap', 'middle', 'top']);
  });

  it('throws a ConfigError naming every problem', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tally-cfg-')), 'tally.yaml');
    writeFileSync(path, 'version: 1\nrepo: { path: . }\n');
    try {
      loadConfig(path);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems.join('\n');
      expect(problems).toContain('baseBranch');
      expect(problems).toContain('tiers');
    }
  });

  it('throws a ConfigError when the file is missing', () => {
    expect(() => loadConfig('/nonexistent/tally.yaml')).toThrow(ConfigError);
  });
});
