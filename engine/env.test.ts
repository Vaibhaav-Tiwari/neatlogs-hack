import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultEnvPath, loadEnv, secretStatus } from './env.js';

function envFile(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tally-env-')), '.env');
  writeFileSync(path, body);
  return path;
}

describe('loadEnv', () => {
  it('reads KEY=VALUE lines, skipping comments, blanks and empty values', () => {
    const env = loadEnv(envFile('# comment\n\nA_KEY=abc123\nEMPTY=\nexport B_KEY="quoted value"\nC_KEY=has=equals # not a comment\n'));
    expect(env).toEqual({ A_KEY: 'abc123', B_KEY: 'quoted value', C_KEY: 'has=equals # not a comment' });
  });

  it('returns nothing when the file does not exist', () => {
    expect(loadEnv('/nonexistent/tally/.env')).toEqual({});
  });

  it('defaults to ~/.tally/.env, outside any repository', () => {
    expect(defaultEnvPath()).toMatch(/[\\/]\.tally[\\/]\.env$/);
  });
});

describe('secretStatus', () => {
  it('reports which names are set without exposing values', () => {
    const status = secretStatus({ A_KEY: 'super-secret' }, ['A_KEY', 'B_KEY']);
    expect(status).toEqual({ A_KEY: 'set', B_KEY: 'missing' });
    expect(JSON.stringify(status)).not.toContain('super-secret');
  });
});
