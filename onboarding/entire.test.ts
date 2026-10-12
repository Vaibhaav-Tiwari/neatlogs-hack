import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sampleConfig } from '../agent/testing/fakes.js';
import { EntireOnboarding, type EntireOnboardingCommand } from './entire.js';
import type { OnboardingContext } from './types.js';

function fixture(answers: boolean[] = [true]) {
  const cwd = mkdtempSync(join(tmpdir(), 'tally-entire-onboarding-'));
  const entireDirectory = join(cwd, '.entire');
  const settingsPath = join(entireDirectory, 'settings.json');
  const localSettingsPath = join(entireDirectory, 'settings.local.json');
  mkdirSync(entireDirectory, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ enabled: true, commit_linking: 'always' }, null, 2) + '\n');
  const state = { loggedIn: true, graph: true, enabled: true, agents: ['Codex'], dirty: '', generated: '', branch: 'main',
    local: 'base-sha', remote: 'base-sha', published: true, remoteHooks: true, settingsChanged: false, publishedCommitLinking: 'always', fail: '', loginWorks: true, pluginWorks: true,
    mirrors: [] as Array<{ repo: string; status: string; placements: Array<{ cluster: string; status: string }> }>, mirrorAdded: false };
  const calls: { file: string; args: string[]; cwd: string; interactive?: boolean }[] = [];
  const command: EntireOnboardingCommand = async (file, args, options) => {
    calls.push({ file, args, ...options });
    const name = `${file} ${args.join(' ')}`;
    if (state.fail && name.startsWith(state.fail)) throw new Error('fake-private-error');
    let stdout = '';
    if (file === 'entire') {
      if (args[0] === '--version') stdout = 'entire version fake';
      else if (args[0] === 'auth') stdout = JSON.stringify({ logged_in: state.loggedIn });
      else if (args[0] === 'plugin' && args[1] === 'list') stdout = state.graph ? 'Managed plugin directory\n  graph v0.4.0' : 'No installed plugins';
      else if (args[0] === 'plugin') state.graph = state.pluginWorks;
      else if (args[0] === 'login') state.loggedIn = state.loginWorks;
      else if (args[0] === 'status') stdout = JSON.stringify({ enabled: state.enabled, agents: state.agents });
      else if (args[0] === 'enable') {
        state.enabled = true;
        state.agents = [args[args.indexOf('--agent') + 1]! === 'codex' ? 'Codex' : 'Claude Code'];
        state.generated = '?? .entire/settings.json\n?? .codex/hooks.json';
        mkdirSync(entireDirectory, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ enabled: true, commit_linking: 'prompt' }, null, 2) + '\n');
        state.settingsChanged = true;
      }
      else if (args[0] === 'agent') { state.agents.push(args[2] === 'codex' ? 'Codex' : 'Claude Code'); state.generated = ' M .codex/hooks.json'; }
      else if (args[0] === 'repo' && args[1] === 'mirror' && args[2] === 'list') stdout = JSON.stringify(state.mirrors);
      else if (args[0] === 'repo' && args[1] === 'mirror' && args[2] === 'add') state.mirrorAdded = true;
      else if (args[0] === 'repo' && args[1] === 'view') stdout = JSON.stringify({ placements: state.mirrorAdded ? [{ cluster: 'aws-ap-south-1.entire.io', status: 'ready' }] : [] });
      else throw new Error(`Unexpected ${name}`);
    } else if (file === 'git') {
      if (args[0] === 'rev-parse') stdout = args[1] === '--show-toplevel' ? cwd : args[1] === 'HEAD' ? state.local : state.remote;
      else if (args[0] === 'status') {
        const scopedPaths = args.filter(arg => arg.startsWith('.'));
        if (!scopedPaths.length || args.includes('--untracked-files=all')) stdout = state.dirty || state.generated;
        else {
          const generated = state.generated.split('\n').filter(Boolean).filter(line => scopedPaths.includes(line.slice(3)));
          const settingsChanged = scopedPaths.includes('.entire/settings.json')
            && (state.settingsChanged || JSON.parse(readFileSync(settingsPath, 'utf8')).commit_linking !== state.publishedCommitLinking);
          stdout = [...(settingsChanged ? [' M .entire/settings.json'] : []), ...generated].filter((line, index, all) => all.indexOf(line) === index).join('\n');
        }
      }
      else if (args[0] === 'ls-files') stdout = '';
      else if (args[0] === 'branch') stdout = state.branch;
      else if (args[0] === 'symbolic-ref') stdout = 'origin/main';
      else if (args[0] === 'show') stdout = args[1]!.endsWith('.entire/settings.json') ? JSON.stringify({ enabled: state.published }) : state.remoteHooks ? '{"command":"entire hooks codex SessionStart"}' : '{"hooks":{}}';
      else if (args[0] === 'commit') {
        state.generated = '';
        state.settingsChanged = false;
        state.publishedCommitLinking = JSON.parse(readFileSync(settingsPath, 'utf8')).commit_linking as string;
        state.local = 'setup-sha';
      }
      else if (args[0] === 'push') { state.remote = state.local; state.published = true; }
      else if (args[0] !== 'add') throw new Error(`Unexpected ${name}`);
    } else throw new Error(`Unexpected ${name}`);
    return { stdout };
  };
  const config = sampleConfig();
  config.tiers = config.tiers.map(t => ({ ...t, harness: 'codex' }));
  const context: OnboardingContext = { repoRoot: cwd, config, ui: { print: vi.fn(), confirm: vi.fn(async () => answers.shift() ?? false), select: vi.fn(async () => null) } };
  const module = new EntireOnboarding({ cwd, command });
  return { state, calls, context, module, command, cwd, settingsPath, localSettingsPath };
}
const mutations = (calls: ReturnType<typeof fixture>['calls']) => calls.filter(c =>
  c.file === 'entire' && ['login', 'enable', 'agent'].includes(c.args[0]!) ||
  c.file === 'entire' && c.args[0] === 'plugin' && c.args[1] === 'install' ||
  c.file === 'git' && ['add', 'commit', 'push'].includes(c.args[0]!));

describe('Entire onboarding', () => {
  it('checks a configured repository without mutations', async () => {
    const f = fixture();
    expect((await f.module.check()).status).toBe('ok');
    expect(mutations(f.calls)).toEqual([]);
  });
  it('reuses a configured repository and asks the human to trust hooks in their coding agent', async () => {
    const f = fixture();
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(mutations(f.calls)).toEqual([]);
    expect(f.context.ui.print).toHaveBeenCalledWith(expect.stringContaining('your coding agent'));
    expect(vi.mocked(f.context.ui.print).mock.calls.join('\n')).not.toContain(';');
    expect(vi.mocked(f.context.ui.confirm).mock.calls.join('\n')).toContain('Have you reviewed and trusted the Entire hooks in your coding agent for this repository?');
    expect(f.calls.every(call => call.cwd === f.context.repoRoot)).toBe(true);
  });
  it('offers a one-time automatic session-link setting instead of prompting for every Tally commit', async () => {
    const f = fixture([true, true]);
    const before = JSON.parse(readFileSync(f.settingsPath, 'utf8')) as Record<string, unknown>;
    before.commit_linking = 'prompt';
    writeFileSync(f.settingsPath, JSON.stringify(before, null, 2) + '\n');
    f.state.publishedCommitLinking = 'prompt';

    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(JSON.parse(readFileSync(f.settingsPath, 'utf8'))).toMatchObject({ enabled: true, commit_linking: 'always' });
    expect(f.calls.find(call => call.file === 'git' && call.args[0] === 'add')?.args).toEqual(['add', '--', '.entire/settings.json']);
    expect(vi.mocked(f.context.ui.confirm).mock.calls.map(call => call[0])).toEqual([
      'Enable automatic session linking and publish only this setting to origin/main?',
      'Have you reviewed and trusted the Entire hooks in your coding agent for this repository?',
    ]);
    const preview = vi.mocked(f.context.ui.print).mock.calls.map(call => call.join(' ')).join('\n');
    expect(preview).toContain('Commit linking: automatic for this repository');
    expect(preview).not.toContain('local Git hooks');
    expect(preview).not.toContain('.codex/hooks.json');
  });
  it('does not change Entire commit linking when the one-time setup change is declined', async () => {
    const f = fixture([false]);
    const settings = JSON.parse(readFileSync(f.settingsPath, 'utf8')) as Record<string, unknown>;
    settings.commit_linking = 'prompt';
    writeFileSync(f.settingsPath, JSON.stringify(settings, null, 2) + '\n');
    f.state.publishedCommitLinking = 'prompt';

    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(JSON.parse(readFileSync(f.settingsPath, 'utf8')).commit_linking).toBe('prompt');
    expect(f.calls.some(call => call.file === 'git' && ['add', 'commit', 'push'].includes(call.args[0]!))).toBe(false);
  });
  it('updates a local Entire override without staging local settings', async () => {
    const f = fixture([true, true]);
    writeFileSync(f.localSettingsPath, JSON.stringify({ commit_linking: 'prompt', userOption: 'preserved' }, null, 2) + '\n');

    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(JSON.parse(readFileSync(f.localSettingsPath, 'utf8'))).toEqual({ commit_linking: 'always', userOption: 'preserved' });
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('settings.local.json will be updated in this checkout');
    expect(f.calls.some(call => call.file === 'git' && call.args[0] === 'add')).toBe(false);
    expect(f.calls.some(call => call.file === 'git' && call.args[0] === 'push')).toBe(false);
  });
  it('leaves a tracked local Entire settings override untouched', async () => {
    const f = fixture([true]);
    writeFileSync(f.localSettingsPath, JSON.stringify({ commit_linking: 'prompt' }, null, 2) + '\n');
    const command: EntireOnboardingCommand = async (file, args, options) => {
      if (file === 'git' && args[0] === 'ls-files') return { stdout: '.entire/settings.local.json' };
      return f.command(file, args, options);
    };
    f.module = new EntireOnboarding({ cwd: f.cwd, command });

    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(JSON.parse(readFileSync(f.localSettingsPath, 'utf8')).commit_linking).toBe('prompt');
    expect(f.calls.some(call => call.file === 'git' && ['add', 'commit', 'push'].includes(call.args[0]!))).toBe(false);
  });
  it('reports an existing mirror without asking or changing it', async () => {
    const f = fixture([true]);
    f.context.config.repo.slug = 'acme/widgets';
    f.state.mirrors = [{ repo: '/gh/acme/widgets', status: 'ready', placements: [{ cluster: 'aws-ap-south-1.entire.io', status: 'ready' }] }];
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(f.calls.some(c => c.args.join(' ') === 'repo mirror add /gh/acme/widgets --timeout 5m')).toBe(false);
    expect(vi.mocked(f.context.ui.confirm).mock.calls).toHaveLength(1);
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('Entire mirror ready on aws-ap-south-1.entire.io.');
  });
  it('asks before creating an Entire mirror and lets the Entire CLI collect region choice', async () => {
    const f = fixture([true, true]);
    f.context.config.repo.slug = 'acme/widgets';
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    const add = f.calls.find(c => c.args.join(' ') === 'repo mirror add /gh/acme/widgets --timeout 5m');
    expect(add?.interactive).toBe(true);
    expect(f.calls.some(c => c.args.join(' ') === 'repo view /gh/acme/widgets --json')).toBe(true);
    expect(vi.mocked(f.context.ui.confirm).mock.calls[1]![0]).toBe('Mirror this repository in Entire?');
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('Entire mirror ready for acme/widgets.');
  });
  it('keeps Entire enabled when the user skips the optional mirror', async () => {
    const f = fixture([true, false]);
    f.context.config.repo.slug = 'acme/widgets';
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(f.state.mirrorAdded).toBe(false);
    expect(f.calls.some(c => c.args[0] === 'repo' && c.args[1] === 'mirror' && c.args[2] === 'add')).toBe(false);
  });
  it('keeps Entire off when hook trust is skipped', async () => {
    const f = fixture([false]);
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(mutations(f.calls)).toEqual([]);
  });
  it('offers login and verifies the session after approval', async () => {
    const f = fixture([true, true]);
    f.state.loggedIn = false;
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(f.calls.find(call => call.args[0] === 'login')?.interactive).toBe(true);
  });
  it('offers the official CLI installer after an ENOENT and verifies the installed command', async () => {
    const f = fixture([true, true]);
    let installed = false;
    const base = f.command;
    const command: EntireOnboardingCommand = async (file, args, options) => {
      if (file === 'entire' && args[0] === '--version' && !installed) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return base(file, args, options);
    };
    const install = vi.fn(async () => { installed = true; return 'entire'; });
    const module = new EntireOnboarding({ cwd: f.context.repoRoot, command, install });
    expect((await module.configure(f.context)).enabled).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(f.context.ui.confirm).toHaveBeenCalledWith('Install Entire CLI using its official installer?');
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('https://docs.entire.io/installation');
  });
  it('does not install Entire unless the user explicitly accepts', async () => {
    const f = fixture([false]);
    const base = f.command;
    const command: EntireOnboardingCommand = async (file, args, options) => {
      if (file === 'entire' && args[0] === '--version') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return base(file, args, options);
    };
    const install = vi.fn(async () => 'entire');
    const module = new EntireOnboarding({ cwd: f.context.repoRoot, command, install });
    expect((await module.configure(f.context)).enabled).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.file === 'entire' && ['login', 'enable'].includes(call.args[0]!))).toBe(false);
  });
  it('gives a sign-up address and fallback when login is declined', async () => {
    const f = fixture([false]);
    f.state.loggedIn = false;
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(mutations(f.calls)).toEqual([]);
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('https://entire.io');
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('code search');
  });
  it('falls back without enabling the repo when login did not succeed', async () => {
    const f = fixture([true]);
    f.state.loggedIn = false;
    f.state.loginWorks = false;
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(f.calls.some(c => c.args[0] === 'enable')).toBe(false);
  });
  it('offers the missing graph plugin and rechecks installation', async () => {
    const f = fixture([true, true]);
    f.state.graph = false;
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(f.calls.filter(c => c.args.join(' ') === 'plugin install graph')).toHaveLength(1);
  });
  it.each(['declined', 'failed'])('stays off for %s graph installation', async mode => {
    const f = fixture([mode !== 'declined']);
    f.state.graph = false;
    f.state.pluginWorks = false;
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(f.calls.some(c => c.args[0] === 'enable')).toBe(false);
  });
  it('shows the capture files before enabling and never commits on setup decline', async () => {
    const f = fixture([false]);
    f.state.enabled = false;
    unlinkSync(f.settingsPath);
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(mutations(f.calls)).toEqual([]);
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('.entire/settings.json');
    expect(vi.mocked(f.context.ui.print).mock.calls.join(' ')).toContain('default branch');
  });
  it('enables, commits only generated settings and pushes the default branch only after separate consent', async () => {
    const f = fixture([true, true, true]);
    f.state.enabled = false;
    f.state.published = false;
    unlinkSync(f.settingsPath);
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(f.calls.find(c => c.args[0] === 'enable')!.args).toEqual(['enable', '--agent', 'codex', '--telemetry=false', '--project', '--no-init-repo', '--skip-initial-commit']);
    expect(f.calls.find(c => c.args[0] === 'add')!.args).toEqual(['add', '--', '.entire/settings.json', '.codex/hooks.json']);
    expect(f.calls.find(c => c.args[0] === 'commit')!.args).toContain('--');
    expect(f.calls.find(c => c.args[0] === 'push')!.args).toEqual(['push', 'origin', 'setup-sha:refs/heads/main']);
    expect(vi.mocked(f.context.ui.confirm).mock.calls[1]![0]).toContain('Commit only these settings');
    expect(JSON.parse(readFileSync(f.settingsPath, 'utf8'))).toMatchObject({ commit_linking: 'always' });
    // Rerun is read-only apart from the human's trust confirmation.
    f.calls.length = 0;
    f.context.ui.confirm = async () => true;
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(mutations(f.calls)).toEqual([]);
  });
  it('does not commit or push when publishing is declined', async () => {
    const f = fixture([true, false]);
    f.state.enabled = false;
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(f.calls.some(c => c.file === 'git' && ['add', 'commit', 'push'].includes(c.args[0]!))).toBe(false);
  });
  it('does not publish if the checkout moved during the approval prompt', async () => {
    const f = fixture();
    f.state.enabled = false;
    let prompt = 0;
    f.context.ui.confirm = async () => {
      if (++prompt === 2) f.state.branch = 'other-work';
      return true;
    };
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(f.calls.some(c => c.file === 'git' && ['commit', 'push'].includes(c.args[0]!))).toBe(false);
  });
  it.each(['feature branch', 'unpublished commits', 'dirty checkout', 'unexpected file'])('refuses unsafe publication with %s', async problem => {
    const f = fixture([true, true]);
    f.state.enabled = false;
    if (problem === 'feature branch') f.state.branch = 'feature';
    if (problem === 'unpublished commits') f.state.local = 'other-unpublished-work';
    if (problem === 'dirty checkout') f.state.dirty = ' M README.md';
    if (problem === 'unexpected file') {
      const base = f.command;
      f.module = new EntireOnboarding({ cwd: f.context.repoRoot, command: async (file, args, options) => {
        const result = await base(file, args, options);
        if (args[0] === 'enable') f.state.generated += '\n?? private-token.json';
        return result;
      } });
    }
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(f.calls.some(c => c.file === 'git' && ['commit', 'push'].includes(c.args[0]!))).toBe(false);
  });
  it('does not treat a local-only setup as ready on rerun', async () => {
    const f = fixture();
    f.state.generated = ' M .codex/hooks.json';
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(mutations(f.calls)).toEqual([]);
  });
  it.each(['capture disabled', 'hooks absent'])('keeps integration off when remote default-branch evidence has %s', async problem => {
    const f = fixture();
    if (problem === 'capture disabled') f.state.published = false;
    else f.state.remoteHooks = false;
    expect((await f.module.configure(f.context)).enabled).toBe(false);
  });
  it('does not write a checkout different from the init target', async () => {
    const f = fixture();
    f.state.enabled = false;
    f.context.repoRoot = '/tmp/some-other-root';
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(mutations(f.calls)).toEqual([]);
  });
  it.each(['entire --version', 'entire auth status', 'entire plugin install', 'entire enable', 'git commit', 'git push'])('handles %s failure with no secret-bearing error output', async failing => {
    const f = fixture([true, true, true, true]);
    f.state.fail = failing;
    if (failing === 'entire plugin install') f.state.graph = false;
    if (['entire enable', 'git commit', 'git push'].includes(failing)) f.state.enabled = false;
    expect((await f.module.configure(f.context)).enabled).toBe(false);
    expect(JSON.stringify(vi.mocked(f.context.ui.print).mock.calls)).not.toContain('fake-private-error');
  });
  it('adds missing capture hooks for the configured harness with explicit consent', async () => {
    const f = fixture([true, true, true]);
    f.state.agents = ['Claude Code'];
    expect((await f.module.configure(f.context)).enabled).toBe(true);
    expect(f.calls.find(c => c.args[0] === 'agent')!.args).toEqual(['agent', 'add', 'codex']);
    expect(f.calls.find(c => c.args[0] === 'add')!.args).toEqual(['add', '--', '.codex/hooks.json']);
  });
});
