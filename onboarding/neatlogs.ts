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
    return { status: key ? 'ok' : 'missing', detail: key ? 'Neatlogs project key found. Connection check has not run.' : 'Neatlogs needs a project API key.' };
  }
  async connect(context: OnboardingContext): Promise<IntegrationState> {
    this.key = null;
    const ui = context.ui;
    let key = this.env().NEATLOGS_API_KEY ?? null;
    ui.print('Neatlogs connection');
    ui.print('  Tally sends routing and task traces to your Neatlogs project.');
    if (key) {
      ui.print('  A project API key is already configured.');
      ui.print('  The connection check sends one synthetic span with no repository content.');
    } else {
      ui.print('  You need a project API key to send traces.');
      ui.print(`  Create a key: ${NEATLOGS_KEYS_URL}`);
      ui.print('  The connection check sends one synthetic span with no repository content.');
    }
    if (!await ui.confirm(key ? 'Verify the configured Neatlogs project key now?' : 'Connect Tally to Neatlogs now?')) {
      if (key) { this.key = key; return { status: 'ok', detail: 'Neatlogs key found. Connection check skipped.' }; }
      return { status: 'off', detail: 'Neatlogs skipped. Tally keeps routing and costs in the local ledger.' };
    }
    try {
      if (!key) {
        await (this.options.openBrowser ?? openBrowser)(NEATLOGS_KEYS_URL);
        key = await (this.options.readSecret ?? readHiddenSecret)('neatlogs project API key');
      }
      if (!key) return { status: 'off', detail: 'neatlogs skipped: no API key supplied.' };
      if (!await (this.options.probe ?? probe)(key)) {
        ui.print('Neatlogs could not verify this key. The key was not saved.');
        if (!await ui.confirm('Open the API keys page and try another key?')) return { status: 'missing', detail: 'Neatlogs could not verify the project key. It was not saved.' };
        await (this.options.openBrowser ?? openBrowser)(NEATLOGS_KEYS_URL);
        key = await (this.options.readSecret ?? readHiddenSecret)('Neatlogs replacement project API key');
        if (!key || !await (this.options.probe ?? probe)(key)) return { status: 'missing', detail: 'Replacement key was not verified. No key was saved.' };
      }
      if (key !== this.env().NEATLOGS_API_KEY) (this.options.save ?? saveSecrets)({ NEATLOGS_API_KEY: key });
      this.key = key;
      return { status: 'ok', detail: 'Neatlogs project key verified with a synthetic probe.' };
    } catch { return { status: 'missing', detail: 'Neatlogs connection did not complete. Credentials were not printed or saved.' }; }
  }
  async configure(context: OnboardingContext): Promise<OnboardingResult> {
    const state = await this.connect(context);
    if (state.status !== 'ok' || !this.key) return { enabled: false, state };
    context.ui.print('Past-run history (optional)');
    context.ui.print('  Lets Tally use earlier costs and outcomes when routing future tasks.');
    context.ui.print('  Requires a read-only service token with context:read and observability:read.');
    context.ui.print('  The token and selected project are saved in ~/.tally/.env.');
    if (await context.ui.confirm('Connect read-only history from Neatlogs?')) {
      try {
        const token = this.env().NEATLOGS_TOKEN ?? await (this.options.readSecret ?? readHiddenSecret)('Neatlogs read-only service token');
        if (token) {
          const available = await (this.options.projects ?? projects)(token);
          if (!available.length) {
            context.ui.print('No Neatlogs projects were available to this token. Tally will use local history.');
          }
          const index = available.length === 1 ? 0 : available.length ? await context.ui.select('Choose a Neatlogs project. Press Enter to skip.', available.map(p => p.name)) : null;
          const selected = index === null ? undefined : available[index];
          if (selected) {
            const verified = this.options.verifyProject ? await this.options.verifyProject(token, selected.id) : await this.verifyProject(token, selected.id);
            if (!verified) throw new Error('Project read failed');
            (this.options.save ?? saveSecrets)({ NEATLOGS_TOKEN: token, NEATLOGS_PROJECT_ID: selected.id });
            context.ui.print('Neatlogs history connected. Read token saved outside the repository.');
          } else if (available.length) context.ui.print('Neatlogs history skipped. Tally will use local history.');
        } else context.ui.print('Neatlogs history skipped. Tally will use local history.');
      } catch { context.ui.print('Neatlogs history could not be verified. Tally will use local history.'); }
    } else context.ui.print('Neatlogs history not connected. Tally will use local history.');
    context.ui.print('Worker traces (optional)');
    context.ui.print('  Machine-wide hooks capture Claude Code and Codex sessions on this computer.');
    context.ui.print('  They update ~/.claude/settings.json and ~/.codex/hooks.json.');
    if (await context.ui.confirm('Install Neatlogs hooks for all matching sessions on this computer?')) {
      try {
        await (this.options.installHooks ?? installGlobalNeatlogsHooks)({ NEATLOGS_API_KEY: this.key });
        context.ui.print('Neatlogs hooks installed. In Codex, open /hooks, review them, then trust them.');
      } catch { context.ui.print('Neatlogs hooks could not be installed. Tally decision tracing remains enabled.'); }
    } else context.ui.print('Machine-wide hooks not installed. Tally decision tracing remains enabled.');
    return { enabled: true, state };
  }
  private async verifyProject(token: string, projectId: string): Promise<boolean> {
    const response = await fetch(`${PUBLIC_API}/traces?limit=1`, { headers: { authorization: `Bearer ${token}`, 'x-project-id': projectId }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) return false;
    const body = await response.json() as { data?: { traces?: unknown } };
    return Array.isArray(body.data?.traces);
  }
}
