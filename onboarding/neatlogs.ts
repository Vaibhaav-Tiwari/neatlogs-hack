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
  harnesses?: Array<'claude-code' | 'codex'>;
  run?: (file: string, args: string[], env: Env) => Promise<void>;
} = {}): Promise<void> {
  const harnesses = [...new Set(options.harnesses ?? ['claude-code', 'codex'])];
  for (const relative of harnesses.flatMap(harness => harness === 'claude-code' ? ['.claude/settings.json'] : ['.codex/hooks.json'])) {
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
  const packages = harnesses.map(harness => harness === 'claude-code' ? '@neatlogs/claude-code' : '@neatlogs/codex');
  if (packages.length) await run('npm', ['install', '--global', ...packages], env);
  for (const harness of harnesses) {
    await run(harness === 'claude-code' ? 'neatlogs-claude-code' : 'neatlogs-codex', ['setup', '--global'], env);
  }
}

export interface NeatlogsOnboardingOptions {
  env?: () => Env;
  probe?: (key: string) => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  readSecret?: (question: string) => Promise<string | null>;
  save?: (values: Env) => void;
  projects?: (token: string) => Promise<{ id: string; name: string }[]>;
  verifyProject?: (token: string, projectId: string) => Promise<boolean>;
  installHooks?: (env: Env, options?: { harnesses: Array<'claude-code' | 'codex'> }) => Promise<void>;
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
      ui.print('  Checking the configured project key with a synthetic test span.');
    } else {
      ui.print('  You need a project API key to send traces.');
      ui.print(`  Create a key: ${NEATLOGS_KEYS_URL}`);
      ui.print('  The connection check sends a synthetic test span with no repository content.');
    }
    try {
      if (!key) {
        await (this.options.openBrowser ?? openBrowser)(NEATLOGS_KEYS_URL);
        key = await (this.options.readSecret ?? readHiddenSecret)('neatlogs project API key');
      }
      if (!key) return { status: 'off', detail: 'neatlogs skipped: no API key supplied.' };
      if (!await (this.options.probe ?? probe)(key)) {
        ui.print('Neatlogs could not verify this key. The key was not saved.');
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
    await this.connectHistory(context);
    const harnesses = [...new Set(context.config.tiers.map(tier => tier.harness))];
    context.ui.print(`Installing Neatlogs worker hooks for ${harnesses.map(h => h === 'codex' ? 'Codex' : 'Claude Code').join(' and ')} on this computer.`);
    context.ui.print('These hooks update your global agent settings and trace sessions for the selected coding agent(s).');
    try {
      await (this.options.installHooks ?? installGlobalNeatlogsHooks)({ NEATLOGS_API_KEY: this.key }, { harnesses });
      context.ui.print('Neatlogs worker hooks installed. Review and trust them in your coding agent if it asks.');
    } catch { context.ui.print('Neatlogs worker hooks could not be installed. Tally decision tracing remains enabled.'); }
    return { enabled: true, state };
  }
  private async connectHistory(context: OnboardingContext): Promise<void> {
    const env = this.env();
    const token = env.NEATLOGS_TOKEN;
    if (!token) {
      context.ui.print('Past-run history is not configured. Add a read token and project ID to ~/.tally/.env to use it. Tally will use local history.');
      return;
    }
    try {
      const projectId = env.NEATLOGS_PROJECT_ID;
      let selected: { id: string; name: string } | undefined;
      if (projectId) {
        selected = { id: projectId, name: projectId };
      } else {
        const available = await (this.options.projects ?? projects)(token);
        if (!available.length) {
          context.ui.print('No Neatlogs projects were available to the history token. Tally will use local history.');
          return;
        }
        const index = available.length === 1 ? 0 : await context.ui.select('Choose the Neatlogs project for past-run history.', available.map(p => p.name));
        selected = index === null ? undefined : available[index];
      }
      if (!selected) {
        context.ui.print('Past-run history was skipped. Tally will use local history.');
        return;
      }
      const verified = this.options.verifyProject ? await this.options.verifyProject(token, selected.id) : await this.verifyProject(token, selected.id);
      if (!verified) throw new Error('Project read failed');
      if (projectId !== selected.id) (this.options.save ?? saveSecrets)({ NEATLOGS_TOKEN: token, NEATLOGS_PROJECT_ID: selected.id });
      context.ui.print('Past-run history connected.');
    } catch {
      context.ui.print('Past-run history could not be verified. Tally will use local history.');
    }
  }
  private async verifyProject(token: string, projectId: string): Promise<boolean> {
    const response = await fetch(`${PUBLIC_API}/traces?limit=1`, { headers: { authorization: `Bearer ${token}`, 'x-project-id': projectId }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) return false;
    const body = await response.json() as { data?: { traces?: unknown } };
    return Array.isArray(body.data?.traces);
  }
}
