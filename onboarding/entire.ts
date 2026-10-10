import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';

export type EntireOnboardingCommand = (file: string, args: string[], options: {
  cwd: string;
  interactive?: boolean;
}) => Promise<{ stdout: string }>;

const command: EntireOnboardingCommand = async (file, args, options) => {
  if (!options.interactive) return promisify(execFile)(file, args, { cwd: options.cwd, timeout: 120_000, encoding: 'utf8' });
  // Entire owns its login and keyring; Tally neither reads nor copies its tokens.
  await new Promise<void>((done, fail) => {
    const child = spawn(file, args, { cwd: options.cwd, stdio: 'inherit' });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error('Entire login did not complete')));
  });
  return { stdout: '' };
};

const SETTINGS_FILES = ['.entire/settings.json', '.entire/.gitignore', '.claude/settings.json', '.codex/hooks.json', '.codex/config.toml', '.gitignore'];
const json = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unreadable Entire status');
  return parsed as Record<string, unknown>;
};

export interface EntireOnboardingOptions {
  cwd?: string;
  command?: EntireOnboardingCommand;
}

export class EntireOnboarding implements IntegrationOnboarding {
  private cwd: string;
  private readonly command: EntireOnboardingCommand;
  constructor(options: EntireOnboardingOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.command = options.command ?? command;
  }
  private async run(file: string, args: string[], interactive = false): Promise<string> {
    return (await this.command(file, args, { cwd: this.cwd, interactive })).stdout.replace(/\r?\n$/, '');
  }
  private async loggedIn(): Promise<boolean> {
    return json(await this.run('entire', ['auth', 'status', '--json'])).logged_in === true;
  }
  private async graphInstalled(): Promise<boolean> {
    return /^\s*graph\s+/m.test(await this.run('entire', ['plugin', 'list']));
  }
  private async status(): Promise<Record<string, unknown>> {
    return json(await this.run('entire', ['status', '--json']));
  }
  async check(): Promise<IntegrationState> {
    try {
      await this.run('entire', ['--version']);
      if (!await this.loggedIn()) return { status: 'missing', detail: 'Entire login is needed; run entire login.' };
      if (!await this.graphInstalled()) return { status: 'missing', detail: 'Entire graph plugin is missing; run entire plugin install graph.' };
      if ((await this.status()).enabled !== true) return { status: 'missing', detail: 'Entire capture is not enabled in this repository.' };
      return { status: 'ok', detail: 'Entire login, graph plugin and repository capture are available.' };
    } catch { return { status: 'missing', detail: 'Entire is unavailable; install instructions and sign-up: https://entire.io.' }; }
  }
  async connect(context: OnboardingContext): Promise<IntegrationState> {
    this.cwd = resolve(context.repoRoot ?? this.cwd);
    try {
      await this.run('entire', ['--version']);
      if (!await this.loggedIn()) {
        context.ui.print('Entire needs its own login. No account? Sign up at https://entire.io or skip for now.');
        if (!await context.ui.confirm('Run entire login to connect this machine?')) return { status: 'off', detail: 'Entire login skipped.' };
        await this.run('entire', ['login'], true);
        if (!await this.loggedIn()) throw new Error('Login not verified');
      }
      if (!await this.graphInstalled()) {
        if (!await context.ui.confirm('Install the Entire graph plugin for code-impact sizing?')) return { status: 'off', detail: 'Entire graph installation skipped.' };
        await this.run('entire', ['plugin', 'install', 'graph']);
        if (!await this.graphInstalled()) throw new Error('Graph plugin not available');
      }
      return { status: 'ok', detail: 'Entire login and graph plugin verified.' };
    } catch { return { status: 'missing', detail: 'Entire connection did not complete; sign-up/install instructions: https://entire.io.' }; }
  }
  async configure(context: OnboardingContext): Promise<OnboardingResult> {
    const off = (detail: string): OnboardingResult => {
      context.ui.print(`${detail} Entire will be off: sizing uses code search and escalation has no Entire checkpoint handoff.`);
      return { enabled: false, state: { status: 'off', detail } };
    };
    const connection = await this.connect(context);
    if (connection.status !== 'ok') return off(connection.detail ?? 'Entire skipped.');
    try {
      const root = await this.run('git', ['rev-parse', '--show-toplevel']);
      if (resolve(root) !== this.cwd) return off('Entire setup needs the target repository root; no capture settings were changed.');
      let status = await this.status();
      const agents = new Set(Array.isArray(status.agents) ? status.agents.map(a => String(a).toLowerCase().replace(/ /g, '-')) : []);
      const required = [...new Set(context.config.tiers.map(t => t.harness))].filter(a => a === 'codex' || a === 'claude-code');
      if (status.enabled !== true || required.some(agent => !agents.has(agent))) {
        // A dirty checkout may contain unrelated or pre-existing settings changes. Never stage them.
        if (await this.run('git', ['status', '--porcelain'])) return off('Entire capture setup needs a clean checkout so existing edits remain untouched.');
        context.ui.print(`Enable Entire capture in ${this.cwd}. It may add or update: ${SETTINGS_FILES.join(', ')} and local Git hooks.`);
        context.ui.print('Settings must be committed to the default branch for worker worktrees to inherit them. Codex hooks need trusting once via /hooks. Telemetry stays off; no summaries are generated.');
        if (!await context.ui.confirm('Enable these repository capture settings? No commit or push yet.')) return off('Entire repository setup declined.');
        const primary = required[0] ?? 'claude-code';
        if (status.enabled !== true) {
          await this.run('entire', ['enable', '--agent', primary, '--telemetry=false', '--project', '--no-init-repo', '--skip-initial-commit']);
          agents.add(primary);
        }
        for (const agent of required) if (!agents.has(agent)) await this.run('entire', ['agent', 'add', agent]);
        status = await this.status();
        if (status.enabled !== true) throw new Error('Capture was not enabled');
        const lines = (await this.run('git', ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean);
        const files = lines.map(line => line.slice(3));
        if (files.some(file => !SETTINGS_FILES.includes(file))) return off('Entire generated unexpected files; review them before publishing. Nothing was committed or pushed.');
        if (files.length) {
          context.ui.print(`Generated settings to publish: ${files.join(', ')}.`);
          const branch = await this.run('git', ['branch', '--show-current']);
          const remoteHead = await this.run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
          const defaultBranch = remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : null;
          if (!defaultBranch || branch !== defaultBranch) return off('Capture is enabled locally, but settings are not on the default branch; publish them through your normal review process, then rerun init.');
          const local = await this.run('git', ['rev-parse', 'HEAD']);
          const remote = await this.run('git', ['rev-parse', `refs/remotes/origin/${defaultBranch}`]);
          if (local !== remote) return off('Default branch has unpublished commits; Entire setup will not publish unrelated work.');
          if (!await context.ui.confirm(`Commit only these settings and push to origin/${defaultBranch}? Entire Git hooks may also publish checkpoint/session evidence.`)) return off('Publishing settings declined; local capture settings remain for review.');
          if (await this.run('git', ['branch', '--show-current']) !== defaultBranch || await this.run('git', ['rev-parse', 'HEAD']) !== local) {
            return off('Checkout moved while awaiting approval; no settings were committed or pushed.');
          }
          await this.run('git', ['add', '--', ...files]);
          await this.run('git', ['commit', '-m', 'chore: enable Entire capture for Tally workers', '--', ...files]);
          const setupCommit = await this.run('git', ['rev-parse', 'HEAD']);
          if (await this.run('git', ['rev-parse', `${setupCommit}^`]) !== local) return off('Setup commit has an unexpected base; no push was attempted.');
          await this.run('git', ['push', 'origin', `${setupCommit}:refs/heads/${defaultBranch}`]);
        }
      }
      if (required.includes('codex')) context.ui.print('In Codex started inside this repository, open /hooks and trust the Entire capture hooks once. Tally cannot approve them for you.');
      // Local enablement alone is insufficient: future workers inherit the default-branch files.
      const pending = await this.run('git', ['status', '--porcelain', '--', ...SETTINGS_FILES]);
      if (pending) return off('Capture settings are still uncommitted; Entire remains off until they are published on the default branch.');
      const published = json(await this.run('git', ['show', 'refs/remotes/origin/HEAD:.entire/settings.json']));
      if (published.enabled !== true) return off('Entire capture is not enabled on the remote default branch yet.');
      for (const agent of required) {
        const file = agent === 'codex' ? '.codex/hooks.json' : '.claude/settings.json';
        const settings = await this.run('git', ['show', `refs/remotes/origin/HEAD:${file}`]);
        if (!/\bentire\s+hooks\b/.test(settings)) return off(`The default branch has no Entire ${agent} hooks yet.`);
      }
      if (required.includes('codex') && !await context.ui.confirm('Have you trusted the Entire hooks via /hooks in Codex for this repository?')) {
        return off('Codex hook trust is not confirmed; no worker was started.');
      }
      return { enabled: true, state: { status: 'ok', detail: 'Entire login, graph and repository capture configured; generated summaries remain opt-in and off by default.' } };
    } catch { return off('Entire setup could not be verified. Any generated files remain for review; no further changes were attempted.'); }
  }
}
