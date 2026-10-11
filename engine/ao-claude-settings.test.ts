import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { claudeAllowList } from './harness.js';
import { aoClaudeSetupCommand, installAoClaudeSettings } from './ao-claude-settings.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tally-ao-claude-'));
  const root = join(directory, 'root');
  const worktreePath = join(directory, 'worker');
  const common = join(root, '.git');
  const scriptRoot = join(directory, 'scripts');
  mkdirSync(common, { recursive: true });
  mkdirSync(worktreePath);
  const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
  config.runner = 'ao';
  config.repo.path = '.';
  config.repo.aoProject = 'fake-project';
  config.test = { command: 'printf test-ok | cat > proof.txt', setupCommand: 'printf setup-ok', timeoutSec: 30 };
  config.claudeCode = { allow: claudeAllowList(config.test) };
  const configPath = join(root, 'tally.yaml');
  writeFileSync(configPath, stringify(config));
  const command = vi.fn(async (_file: string, args: string[], _options: { cwd: string }) => ({ stdout: args[0] === 'rev-parse' ? common : '', stderr: '' }));
  const save = () => writeFileSync(configPath, stringify(config));
  return { configPath, worktreePath, scriptRoot, command, config, common, save, root };
}

describe('AO Claude local settings', () => {
  it('runs only the consented external setup executable before launch and propagates setup failure', async () => {
    const f = fixture();
    const command = vi.fn(async (file: string, args: string[], options: { cwd: string }) => {
      if (file === 'git') return f.command(file, args, options);
      expect(file).toContain(f.scriptRoot);
      expect(args).toEqual([]);
      expect(options.cwd).toBe(realpathSync(f.worktreePath));
      expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\nset -e\nprintf setup-ok\n');
      expect(existsSync(join(f.worktreePath, '.claude/settings.local.json'))).toBe(true);
      return { stdout: 'setup-ok', stderr: '' };
    });
    await installAoClaudeSettings({ ...f, command, runSetup: true });
    expect(command.mock.calls.filter(([file]) => file !== 'git')).toHaveLength(1);
    await expect(installAoClaudeSettings({ ...f, runSetup: true, command: async (file, args, options) => {
      if (file === 'git') return f.command(file, args, options);
      throw new Error('approved setup failed');
    } })).rejects.toThrow('approved setup failed');
  });
  it('materializes content-bound scripts outside the worker and preserves hooks/settings', async () => {
    const f = fixture();
    mkdirSync(join(f.worktreePath, '.claude'));
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'entire hooks claude-code stop' }] }] };
    writeFileSync(join(f.worktreePath, '.claude/settings.local.json'), JSON.stringify({ hooks, env: { KEEP: 'yes' }, permissions: { allow: ['Bash(*)'], deny: ['Read(./secret)'] } }));
    writeFileSync(join(f.worktreePath, 'CLAUDE.local.md'), '# Existing local instructions\n');
    const result = await installAoClaudeSettings(f);
    expect(result.installed).toBe(true);
    expect(result.testScript).not.toContain(f.worktreePath);
    expect(readFileSync(result.testScript!, 'utf8')).toBe('#!/bin/sh\nset -e\nprintf test-ok | cat > proof.txt\n');
    expect(statSync(result.testScript!).mode & 0o777).toBe(0o500);
    const settings = JSON.parse(readFileSync(result.settingsPath!, 'utf8'));
    expect(settings.hooks).toEqual(hooks);
    expect(settings.env).toEqual({ KEEP: 'yes' });
    expect(settings.permissions.defaultMode).toBe('dontAsk');
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(settings.permissions.allow).toContain(`Bash(${result.testScript})`);
    expect(settings.permissions.allow).toContain('Bash(git commit *)');
    expect(settings.permissions.allow).not.toContain('Bash(*)');
    expect(settings.permissions.allow.join(' ')).not.toContain('{{tally.');
    expect(settings.permissions.deny).toContain('Read(./secret)');
    expect(settings.permissions.deny).toContain('Bash(git push *)');
    expect(settings.permissions.deny.some((rule: string) => rule.includes(f.scriptRoot))).toBe(true);
    expect(statSync(result.settingsPath!).mode & 0o777).toBe(0o600);
    const local = readFileSync(join(f.worktreePath, 'CLAUDE.local.md'), 'utf8');
    expect(local).toContain('# Existing local instructions');
    expect(local).toContain(`\`${result.testScript}\``);
    expect(local).toContain(`\`${result.setupScript}\``);
    expect(local).toContain('without extra arguments');
    // Real shell command, no paid harness: the pipeline is inside the trusted script.
    execFileSync(result.testScript!, [], { cwd: f.worktreePath });
    expect(readFileSync(join(f.worktreePath, 'proof.txt'), 'utf8')).toBe('test-ok');
  });
  it('is idempotent, retains local notes and exclusions, and rejects a changed script', async () => {
    const f = fixture();
    mkdirSync(join(f.common, 'info'));
    writeFileSync(join(f.common, 'info/exclude'), '# User exclusions\nprivate.txt\n');
    const first = await installAoClaudeSettings(f);
    const settings = readFileSync(first.settingsPath!, 'utf8');
    const local = readFileSync(join(f.worktreePath, 'CLAUDE.local.md'), 'utf8');
    const exclude = readFileSync(join(f.common, 'info/exclude'), 'utf8');
    expect(await installAoClaudeSettings(f)).toEqual(first);
    expect(readFileSync(first.settingsPath!, 'utf8')).toBe(settings);
    expect(readFileSync(join(f.worktreePath, 'CLAUDE.local.md'), 'utf8')).toBe(local);
    expect(readFileSync(join(f.common, 'info/exclude'), 'utf8')).toBe(exclude);
    expect(exclude).toContain('private.txt');
    expect(exclude).toContain('/.claude/settings.local.json');
    expect(exclude).toContain('/CLAUDE.local.md');
    chmodSync(first.testScript!, 0o600);
    writeFileSync(first.testScript!, 'tampered');
    await expect(installAoClaudeSettings(f)).rejects.toThrow('script changed');
    expect(readFileSync(first.settingsPath!, 'utf8')).toBe(settings);
  });
  it.each(['missing', 'legacy', 'changed test'])('refuses %s consent before writing', async kind => {
    const f = fixture();
    if (kind === 'missing') delete f.config.claudeCode;
    if (kind === 'legacy') f.config.claudeCode = { allow: ['Edit(./**)', `Bash(${f.config.test.command})`] };
    if (kind === 'changed test') f.config.test.command = 'unapproved';
    f.save();
    await expect(installAoClaudeSettings(f)).rejects.toThrow('consent is missing or outdated');
    expect(existsSync(join(f.worktreePath, '.claude'))).toBe(false);
    expect(existsSync(f.scriptRoot)).toBe(false);
  });
  it('does nothing for Codex-only and direct projects', async () => {
    const f = fixture();
    f.config.tiers.forEach(tier => { tier.harness = 'codex'; });
    f.save();
    expect(await installAoClaudeSettings(f)).toEqual({ installed: false });
    f.config.runner = 'direct';
    f.config.tiers.forEach(tier => { tier.harness = 'claude-code'; });
    f.save();
    expect(await installAoClaudeSettings(f)).toEqual({ installed: false });
    expect(f.command).not.toHaveBeenCalled();
  });
  it('refuses the project checkout, unrelated repo, tracked files and malformed settings', async () => {
    const f = fixture();
    await expect(installAoClaudeSettings({ ...f, worktreePath: f.root })).rejects.toThrow('not the project checkout');
    const unrelated = join(f.root, 'other-git');
    mkdirSync(unrelated);
    f.command.mockImplementationOnce(async () => ({ stdout: unrelated, stderr: '' }));
    await expect(installAoClaudeSettings(f)).rejects.toThrow('not a worktree');
    f.command.mockImplementationOnce(async () => ({ stdout: f.common, stderr: '' }))
      .mockImplementationOnce(async () => ({ stdout: f.common, stderr: '' }))
      .mockImplementationOnce(async () => ({ stdout: '.claude/settings.local.json', stderr: '' }));
    await expect(installAoClaudeSettings(f)).rejects.toThrow('are tracked');
    mkdirSync(join(f.worktreePath, '.claude'));
    writeFileSync(join(f.worktreePath, '.claude/settings.local.json'), '[]');
    await expect(installAoClaudeSettings(f)).rejects.toThrow('Invalid existing');
    expect(readFileSync(join(f.worktreePath, '.claude/settings.local.json'), 'utf8')).toBe('[]');
  });
  it('refuses symlinked local settings and scripts inside the worktree', async () => {
    const f = fixture();
    await expect(installAoClaudeSettings({ ...f, scriptRoot: join(f.worktreePath, 'scripts') })).rejects.toThrow('outside the worker');
    mkdirSync(join(f.worktreePath, '.claude'));
    symlinkSync(join(f.root, 'missing-settings'), join(f.worktreePath, '.claude/settings.local.json'));
    await expect(installAoClaudeSettings(f)).rejects.toThrow('Refusing symlink');
    expect(existsSync(join(f.root, 'missing-settings'))).toBe(false);
  });
  it('builds a shell-quoted post-create command for the trusted root config', () => {
    const command = aoClaudeSetupCommand('/tmp/repo with space/tally.yaml');
    expect(command).toContain("'/tmp/repo with space/tally.yaml'");
    expect(command).toContain('/bin/tally-worker-settings.js');
    expect(command).not.toContain('/dist/bin/');
    expect(command).not.toContain('bypass');
  });
  it('keeps generated local files out of git add/commit in a real linked worktree', async () => {
    const f = fixture();
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(f.root, ['init', '-b', 'main']);
    git(f.root, ['-c', 'user.name=Tally test', '-c', 'user.email=tally@example.invalid', 'commit', '--allow-empty', '-m', 'seed']);
    // fixture created an empty worker directory; git accepts it as the worktree path.
    git(f.root, ['worktree', 'add', '-b', 'worker-proof', f.worktreePath, 'main']);
    const result = await installAoClaudeSettings({ ...f, command: undefined });
    expect(result.installed).toBe(true);
    expect(git(f.worktreePath, ['check-ignore', '.claude/settings.local.json', 'CLAUDE.local.md']).trim().split('\n')).toEqual(['.claude/settings.local.json', 'CLAUDE.local.md']);
    git(f.worktreePath, ['add', '.']);
    expect(git(f.worktreePath, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(git(f.worktreePath, ['status', '--porcelain']).trim()).toBe('');
  });
});
