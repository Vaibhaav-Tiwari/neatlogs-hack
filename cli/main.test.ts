import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, main, parseCli } from './main.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err };
}

describe('parseCli', () => {
  it('parses each command', () => {
    for (const command of COMMANDS) {
      expect(parseCli([command])).toMatchObject({ kind: 'command', command });
    }
  });

  it('parses run options', () => {
    expect(parseCli(['run', '--dry-run', '--budget', '40', '--only', 'T3', '--baseline', '--config', 'x/tally.yaml'])).toEqual({
      kind: 'command',
      command: 'run',
      options: { config: 'x/tally.yaml', dryRun: true, baseline: true, budgetUsd: 40, only: 'T3' },
    });
  });

  it('defaults the config path and leaves budget unset', () => {
    expect(parseCli(['run'])).toEqual({
      kind: 'command',
      command: 'run',
      options: { config: 'tally.yaml', dryRun: false, baseline: false, budgetUsd: undefined, only: undefined },
    });
  });

  it('rejects a budget that is not a positive number', () => {
    expect(parseCli(['run', '--budget', 'lots'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--budget', '-5'])).toMatchObject({ kind: 'error' });
  });

  it('rejects unknown commands and unknown flags', () => {
    expect(parseCli(['deploy'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--nope'])).toMatchObject({ kind: 'error' });
  });

  it('treats no arguments, --help and -h as help', () => {
    expect(parseCli([])).toEqual({ kind: 'help' });
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['run', '-h'])).toEqual({ kind: 'help' });
  });

  it('reports the version', () => {
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
  });
});

describe('main', () => {
  it('prints usage listing every command and exits 0 for help', async () => {
    const c = capture();
    expect(await main(['--help'], c.io)).toBe(0);
    for (const command of COMMANDS) expect(c.out.join('\n')).toContain(command);
  });

  it('exits 2 with a message on a bad command', async () => {
    const c = capture();
    expect(await main(['deploy'], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('deploy');
  });

  it('runs the commands that are still stubs and says they are not implemented yet', async () => {
    for (const command of ['init', 'doctor'] as const) {
      const c = capture();
      expect(await main([command], c.io)).toBe(0);
      expect(c.out.join('\n')).toContain('not implemented yet');
    }
  });

  it('reports config errors before a real run can start', async () => {
    const c = capture();
    expect(await main(['run', '--config', '/nonexistent/tally.yaml'], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('file not found');
  });

  it('runs demo and reports the generated files', async () => {
    const c = capture();
    expect(await main(['demo'], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('ledger.json');
    expect(c.out.join('\n')).toContain('attempts');
  });

  it('runs a dry-run from a file backlog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-cli-'));
    const configPath = join(dir, 'tally.yaml');
    writeFileSync(
      configPath,
      `version: 1
repo: { path: ".", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: litellm
    model: nova-micro
    price: { inputUsdPerMTok: 0.035, cachedInputUsdPerMTok: 0.00875, outputUsdPerMTok: 0.14 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 2, large: 3 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
    );
    writeFileSync(join(dir, 'backlog.yaml'), 'tasks:\n  - id: T1\n    title: Tiny fix\n    size: small\n');
    const c = capture();

    expect(await main(['run', '--dry-run', '--config', configPath], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('1 tasks, 1 attempts');
  });
});
