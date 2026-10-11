import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chmodSync, constants, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadEnv } from '../engine/env.js';
import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';
import { readHiddenSecret, saveSecrets } from './secrets.js';

// Confirmed from the public app's route manifest; authentication is still required.
export const NEATLOGS_KEYS_URL = 'https://app.neatlogs.com/settings/api-keys';
const PUBLIC_API = 'https://app.neatlogs.com/api/v1/public';
type Env = Record<string, string>;

async function openBrowser(url: string): Promise<void> {
  const file = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  await promisify(execFile)(file, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { timeout: 15_000 });
}

async function probe(key: string): Promise<boolean> {
  try {
    const entry = createRequire(import.meta.url).resolve('neatlogs');
    const result = await promisify(execFile)(process.execPath, [join(dirname(entry), 'cli.mjs'), 'doctor', '--probe', '--json'], {
      env: { ...process.env, NEATLOGS_API_KEY: key, NEATLOGS_ENDPOINT: 'https://ingest.neatlogs.com' },
      timeout: 90_000, maxBuffer: 1_000_000,
    });
    return JSON.parse(result.stdout).status === 'pass';
  } catch { return false; }
}

async function projects(token: string): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`${PUBLIC_API}/projects`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Read token was not accepted');
  const result = await response.json() as { data?: { projects?: { id?: string; name?: string }[] } };
  if (!Array.isArray(result.data?.projects)) throw new Error('Unreadable project listing');
  return result.data.projects.filter((p): p is { id: string; name: string } => typeof p.id === 'string' && typeof p.name === 'string');
}

export async function installGlobalNeatlogsHooks(env: Env, options: {
  home?: string;
  run?: (file: string, args: string[], env: Env) => Promise<void>;
} = {}): Promise<void> {
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    const file = join(options.home ?? homedir(), relative);
    const backup = `${file}.pre-tally-neatlogs`;
    if (existsSync(file) && !existsSync(backup)) {
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
    }
  }
  // Credentials travel only in the subprocess environment, never its argv or output.
  const run = options.run ?? (async (file, args, values) => {
    await promisify(execFile)(file, args, { env: { ...process.env, ...values }, timeout: 180_000, maxBuffer: 1_000_000 });
  });
  await run('npm', ['install', '--global', '@neatlogs/claude-code', '@neatlogs/codex'], env);
  await run('neatlogs-claude-code', ['setup', '--global'], env);
  await run('neatlogs-codex', ['setup', '--global'], env);
}

export interface NeatlogsOnboardingOptions {
  env?: () => Env;
  probe?: (key: string) => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  readSecret?: (question: string) => Promise<string | null>;
  save?: (values: Env) => void;
  projects?: (token: string) => Promise<{ id: string; name: string }[]>;
  verifyProject?: (token: string, projectId: string) => Promise<boolean>;
  installHooks?: (env: Env) => Promise<void>;
}

export class NeatlogsOnboarding implements IntegrationOnboarding {
  private key: string | null = null;
  constructor(private readonly options: NeatlogsOnboardingOptions = {}) {}
  private env(): Env { return (this.options.env ?? loadEnv)(); }
  async check(): Promise<IntegrationState> {
    const key = this.env().NEATLOGS_API_KEY;
    // A passive check does not export a probe. Verification is a consented connect step.
    return { status: key ? 'ok' : 'missing', detail: key ? 'neatlogs key is configured; connection verification is separate.' : 'neatlogs needs a project API key.' };
  }
  async connect(context: OnboardingContext): Promise<IntegrationState> {
    this.key = null;
    const ui = context.ui;
    let key = this.env().NEATLOGS_API_KEY ?? null;
    ui.print('neatlogs needs a US project API key; sign up at https://app.neatlogs.com or skip. Verification exports only SDK-generated probe spans, not repository data.');
    if (!await ui.confirm(key ? 'Verify the configured neatlogs key with the SDK probe?' : 'Open the neatlogs API keys page and connect?')) {
      if (key) { this.key = key; return { status: 'ok', detail: 'neatlogs key is configured; optional probe skipped (connection not verified).' }; }
      return { status: 'off', detail: 'neatlogs skipped; decisions remain in the local ledger.' };
    }
    try {
      if (!key) {
        await (this.options.openBrowser ?? openBrowser)(NEATLOGS_KEYS_URL);
        key = await (this.options.readSecret ?? readHiddenSecret)('neatlogs project API key');
      }
      if (!key) return { status: 'off', detail: 'neatlogs skipped: no API key supplied.' };
      if (!await (this.options.probe ?? probe)(key)) {
        ui.print('The neatlogs SDK probe rejected that key; it was not saved.');
        if (!await ui.confirm('Open API keys and try a replacement key?')) return { status: 'missing', detail: 'neatlogs SDK probe failed; the key was not saved.' };
        await (this.options.openBrowser ?? openBrowser)(NEATLOGS_KEYS_URL);
        key = await (this.options.readSecret ?? readHiddenSecret)('replacement neatlogs project API key');
        if (!key || !await (this.options.probe ?? probe)(key)) return { status: 'missing', detail: 'Replacement key was not verified or saved.' };
      }
      if (key !== this.env().NEATLOGS_API_KEY) (this.options.save ?? saveSecrets)({ NEATLOGS_API_KEY: key });
      this.key = key;
      return { status: 'ok', detail: 'neatlogs SDK probe passed.' };
    } catch { return { status: 'missing', detail: 'neatlogs connection did not complete; credentials were not printed.' }; }
  }
  async configure(context: OnboardingContext): Promise<OnboardingResult> {
    const state = await this.connect(context);
    if (state.status !== 'ok' || !this.key) return { enabled: false, state };
    if (await context.ui.confirm('Connect optional neatlogs read access for past costs and outcomes?')) {
      try {
        const token = this.env().NEATLOGS_TOKEN ?? await (this.options.readSecret ?? readHiddenSecret)('neatlogs service-account read token');
        if (token) {
          const available = await (this.options.projects ?? projects)(token);
          const index = available.length === 1 ? 0 : await context.ui.select('Choose the neatlogs project (or skip)', available.map(p => p.name));
          const selected = index === null ? undefined : available[index];
          if (selected) {
            const verified = this.options.verifyProject ? await this.options.verifyProject(token, selected.id) : await this.verifyProject(token, selected.id);
            if (!verified) throw new Error('Project read failed');
            (this.options.save ?? saveSecrets)({ NEATLOGS_TOKEN: token, NEATLOGS_PROJECT_ID: selected.id });
            context.ui.print('neatlogs read access verified and saved outside the repository.');
          } else context.ui.print('Read access skipped; local price history remains available.');
        } else context.ui.print('Read access skipped; local price history remains available.');
      } catch { context.ui.print('Read access could not be verified; local price history remains available.'); }
    }
    if (await context.ui.confirm('Install GLOBAL neatlogs worker hooks for Claude Code and Codex? This changes ~/.claude/settings.json and ~/.codex/hooks.json and traces every session on this machine.')) {
      try {
        await (this.options.installHooks ?? installGlobalNeatlogsHooks)({ NEATLOGS_API_KEY: this.key });
        context.ui.print('Global neatlogs hooks installed. In Codex, open /hooks and trust the neatlogs hooks once.');
      } catch { context.ui.print('Global hook setup did not complete; CFO decision tracing remains enabled.'); }
    }
    return { enabled: true, state };
  }
  private async verifyProject(token: string, projectId: string): Promise<boolean> {
    const response = await fetch(`${PUBLIC_API}/traces?limit=1`, { headers: { authorization: `Bearer ${token}`, 'x-project-id': projectId }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) return false;
    const body = await response.json() as { data?: { traces?: unknown } };
    return Array.isArray(body.data?.traces);
  }
}
