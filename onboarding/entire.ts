import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveEntireBinary } from '../adapters/command.js';
import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';

export type EntireOnboardingCommand = (file: string, args: string[], options: {
  cwd: string;
  interactive?: boolean;
}) => Promise<{ stdout: string }>;

export type EntireCliInstaller = () => Promise<string>;

async function installEntireCli(): Promise<string> {
  const run = promisify(execFile);
  const options = { timeout: 180_000, maxBuffer: 1_000_000, encoding: 'utf8' as const };
  if (process.platform === 'darwin') {
    await run('brew', ['install', '--cask', 'entireio/tap/entire'], options);
    const prefix = (await run('brew', ['--prefix'], options)).stdout.trim();
    const binary = join(prefix, 'bin', 'entire');
    return existsSync(binary) ? binary : 'entire';
  }
  if (process.platform === 'linux') {
    await run('bash', ['-lc', 'curl -fsSL https://entire.io/install.sh | bash'], options);
    const local = join(homedir(), '.local', 'bin', 'entire');
    return existsSync(local) ? local : 'entire';
  }
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://entire.io/install.ps1 | iex'], options);
    const binary = join(homedir(), '.local', 'bin', 'entire.exe');
    return existsSync(binary) ? binary : 'entire';
  }
  throw new Error('Automatic Entire installation is not supported on this operating system.');
}

function missingExecutable(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

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
  install?: EntireCliInstaller;
}

interface EntireMirrorPlacement {
  cluster?: unknown;
  status?: unknown;
}

interface EntireMirrorRecord {
  repo?: unknown;
  status?: unknown;
  placements?: EntireMirrorPlacement[];
}

function mirrorRecords(output: string): EntireMirrorRecord[] {
  const parsed: unknown = JSON.parse(output);
  if (Array.isArray(parsed)) return parsed as EntireMirrorRecord[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return (parsed as { items: EntireMirrorRecord[] }).items;
  }
  throw new Error('Unreadable Entire mirror status');
}

export class EntireOnboarding implements IntegrationOnboarding {
  private cwd: string;
  private readonly command: EntireOnboardingCommand;
  private readonly install: EntireCliInstaller;
  private binary: string;
  constructor(options: EntireOnboardingOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.command = options.command ?? command;
    this.install = options.install ?? installEntireCli;
    this.binary = options.command ? 'entire' : resolveEntireBinary();
  }
  private async run(file: string, args: string[], interactive = false): Promise<string> {
    return (await this.command(file === 'entire' ? this.binary : file, args, { cwd: this.cwd, interactive })).stdout.replace(/\r?\n$/, '');
  }
  private async ensureCli(context: OnboardingContext): Promise<boolean> {
    try {
      await this.run('entire', ['--version']);
      return true;
    } catch (error) {
      if (!missingExecutable(error)) throw error;
      context.ui.print('Entire CLI setup');
      context.ui.print('  Tally can install the official Entire CLI for this computer.');
      context.ui.print('  macOS: Homebrew cask. Linux: Entire stable installer. Windows: Entire PowerShell installer.');
      context.ui.print('  This installs a local CLI. Login, Graph plugin, repository hooks, and repository mirror each have separate approval below.');
      context.ui.print('  Install details: https://docs.entire.io/installation');
      if (!await context.ui.confirm('Install Entire CLI using its official installer?')) return false;
      try {
        this.binary = await this.install();
        await this.run('entire', ['--version']);
        context.ui.print('Entire CLI is installed and verified.');
        return true;
      } catch {
        context.ui.print('Entire CLI installation did not complete. No repository capture or hook changes were made.');
        return false;
      }
    }
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
  private async ensureMirror(context: OnboardingContext): Promise<string | null> {
    const slug = context.config.repo.slug;
    if (!slug) return null;
    const repoRef = `/gh/${slug}`;
    let records: EntireMirrorRecord[];
    try {
      records = mirrorRecords(await this.run('entire', ['repo', 'mirror', 'list', '--json', '--mirrored', '--name', slug]));
    } catch {
      const detail = `Could not check Entire mirror status. If you want a browser mirror, run \`entire repo mirror add ${repoRef}\` after onboarding.`;
      context.ui.print(detail);
      return detail;
    }
    const existing = records.find(record => record.repo === repoRef);
    const placements = existing?.placements ?? [];
    if (placements.some(placement => placement.status === 'ready')) {
      const clusters = placements.filter(placement => placement.status === 'ready')
        .map(placement => typeof placement.cluster === 'string' ? placement.cluster : null).filter(Boolean);
      const detail = `Entire mirror ready${clusters.length ? ` on ${clusters.join(', ')}` : ''}.`;
      context.ui.print(detail);
      return detail;
    }
    context.ui.print('Optional Entire browser mirror');
    context.ui.print(`  This creates a copy of ${slug} in Entire so checkpoint sessions can open in its web app.`);
    context.ui.print('  The Entire CLI will ask which region or regions should store the copy. You can skip this.');
    if (!await context.ui.confirm('Mirror this repository in Entire?')) {
      context.ui.print('Entire mirror skipped. Graph sizing and local checkpoint capture remain enabled.');
      return 'Entire mirror skipped.';
    }
    try {
      await this.run('entire', ['repo', 'mirror', 'add', repoRef, '--timeout', '5m'], true);
      const view = json(await this.run('entire', ['repo', 'view', repoRef, '--json']));
      const ready = Array.isArray(view.placements) && view.placements.some(placement =>
        !!placement && typeof placement === 'object' && (placement as EntireMirrorPlacement).status === 'ready');
      if (!ready) throw new Error('Entire mirror is not ready yet');
      context.ui.print(`Entire mirror ready for ${slug}.`);
      return 'Entire mirror ready.';
    } catch {
      const detail = `Entire capture remains enabled, but the mirror could not be verified. Retry with \`entire repo mirror add ${repoRef}\`.`;
      context.ui.print(detail);
      return detail;
    }
  }
  async check(): Promise<IntegrationState> {
    try {
      await this.run('entire', ['--version']);
      if (!await this.loggedIn()) return { status: 'missing', detail: 'Entire login is needed. Run entire login.' };
      if (!await this.graphInstalled()) return { status: 'missing', detail: 'Entire graph plugin is missing. Run entire plugin install graph.' };
      if ((await this.status()).enabled !== true) return { status: 'missing', detail: 'Entire capture is not enabled in this repository.' };
      return { status: 'ok', detail: 'Entire login, graph plugin and repository capture are available.' };
    } catch { return { status: 'missing', detail: 'Entire is unavailable. Install from https://docs.entire.io/installation, then run tally init.' }; }
  }
  async connect(context: OnboardingContext): Promise<IntegrationState> {
    this.cwd = resolve(context.repoRoot ?? this.cwd);
    try {
      if (!await this.ensureCli(context)) return { status: 'off', detail: 'Entire CLI installation skipped or incomplete. Install from https://docs.entire.io/installation, then rerun tally init.' };
      if (!await this.loggedIn()) {
        context.ui.print('Entire account');
        context.ui.print('  Entire uses its own login.');
        context.ui.print('  No account? Sign up at https://entire.io. You can skip this integration.');
        if (!await context.ui.confirm('Open a browser to sign in to Entire?')) return { status: 'off', detail: 'Entire login skipped.' };
        await this.run('entire', ['login'], true);
        if (!await this.loggedIn()) throw new Error('Login not verified');
      }
      if (!await this.graphInstalled()) {
        if (!await context.ui.confirm('Install the Entire graph plugin for code-impact sizing?')) return { status: 'off', detail: 'Entire graph installation skipped.' };
        await this.run('entire', ['plugin', 'install', 'graph']);
        if (!await this.graphInstalled()) throw new Error('Graph plugin not available');
      }
      return { status: 'ok', detail: 'Entire login and graph plugin verified.' };
    } catch { return { status: 'missing', detail: 'Entire connection did not complete. Run tally init to retry or install from https://docs.entire.io/installation.' }; }
  }
  async configure(context: OnboardingContext): Promise<OnboardingResult> {
    const off = (detail: string): OnboardingResult => {
      context.ui.print(`${detail} Entire will be off. Sizing uses code search and will not use Entire checkpoint handoff.`);
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
        context.ui.print('Entire repository capture');
        context.ui.print(`  Repository: ${this.cwd}`);
        context.ui.print('  Settings that may be added or updated:');
        for (const file of SETTINGS_FILES) context.ui.print(`    ${file}`);
        context.ui.print('  Entire also updates local Git hooks.');
        context.ui.print('  Settings must reach the default branch for worker worktrees to inherit them.');
        context.ui.print('  Codex requires you to review and trust its hooks in /hooks. Telemetry and generated summaries stay off.');
        if (!await context.ui.confirm('Enable these repository capture settings?')) return off('Entire repository setup declined.');
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
        if (files.some(file => !SETTINGS_FILES.includes(file))) return off('Entire generated unexpected files. Review them before publishing. Nothing was committed or pushed.');
        if (files.length) {
          context.ui.print('Generated settings to publish:');
          for (const file of files) context.ui.print(`  ${file}`);
          const branch = await this.run('git', ['branch', '--show-current']);
          const remoteHead = await this.run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
          const defaultBranch = remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : null;
          if (!defaultBranch || branch !== defaultBranch) return off('Capture is enabled locally, but settings are not on the default branch. Publish them through your normal review process, then rerun init.');
          const local = await this.run('git', ['rev-parse', 'HEAD']);
          const remote = await this.run('git', ['rev-parse', `refs/remotes/origin/${defaultBranch}`]);
          if (local !== remote) return off('Default branch has unpublished commits. Entire setup will not publish unrelated work.');
          context.ui.print('Entire Git hooks may also publish checkpoint and session evidence.');
          if (!await context.ui.confirm(`Commit only these settings and push them to origin/${defaultBranch}?`)) return off('Publishing settings declined. Local capture settings remain for review.');
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
      if (pending) return off('Capture settings are still uncommitted. Entire remains off until they are published on the default branch.');
      const published = json(await this.run('git', ['show', 'refs/remotes/origin/HEAD:.entire/settings.json']));
      if (published.enabled !== true) return off('Entire capture is not enabled on the remote default branch yet.');
      for (const agent of required) {
        const file = agent === 'codex' ? '.codex/hooks.json' : '.claude/settings.json';
        const settings = await this.run('git', ['show', `refs/remotes/origin/HEAD:${file}`]);
        if (!/\bentire\s+hooks\b/.test(settings)) return off(`The default branch has no Entire ${agent} hooks yet.`);
      }
      if (required.includes('codex') && !await context.ui.confirm('Have you trusted the Entire hooks via /hooks in Codex for this repository?')) {
        return off('Codex hook trust is not confirmed. Entire remains off until you trust the hooks.');
      }
      const mirror = await this.ensureMirror(context);
      return { enabled: true, state: { status: 'ok', detail: ['Entire login, graph and repository capture are configured.', mirror, 'Generated summaries remain off by default.'].filter(Boolean).join(' ') } };
    } catch { return off('Entire setup could not be verified. Any generated files remain for review. No further changes were attempted.'); }
  }
}
