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

  it('runs each stub command and says it is not implemented yet', async () => {
    for (const command of COMMANDS) {
      const c = capture();
      expect(await main([command], c.io)).toBe(0);
      expect(c.out.join('\n')).toContain('not implemented yet');
    }
  });
});
