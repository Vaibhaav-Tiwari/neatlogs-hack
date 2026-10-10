import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { contentHash, configHash, installRecordPath, type InstallRecord } from './install-record.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runDoctor, type DoctorLine } from './doctor.js';

export interface InitCommandResult {
  stdout: string;
  stderr: string;
}

export type InitCommandRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<InitCommandResult>;
export type PromptReader = (question: string, defaultValue?: string) => Promise<string>;

export interface InitOptions {
  cwd?: string;
  configPath?: string;
  command?: InitCommandRunner;
  readLine?: PromptReader;
  doctor?: (configPath: string) => Promise<DoctorLine[]>;
}

export interface InitResult {
  configPath: string;
  projectId: string;
  testCommand: string;
  setupCommand: string | null;
  baseBranch: string;
  tiers: string[];
  doctor: DoctorLine[];
}

const CODEx_TIERS = [
  ['cheap', 'gpt-5.6-luna', 0.2, 0.02, 1.2, 0.2],
  ['middle', 'gpt-5.6-terra', 1, 0.1, 5, 0.5],
  ['top', 'gpt-5.6-sol', 2, 0.2, 10, 1],
] as const;

const CLAUDE_TIERS = [
  ['cheap', 'claude-haiku-4-5-20251001', 1, 0.1, 5, 0.2],
  ['middle', 'claude-sonnet-5-5', 2, 0.2, 10, 0.5],
  ['top', 'claude-opus-5-5', 4, 0.4, 20, 1],
] as const;

export async function defaultCommand(file: string, args: string[], options?: { cwd?: string }): Promise<InitCommandResult> {
  // The CLI config mirror drops fields such as effort; use the full daemon object.
  if (file === 'ao' && args[0] === 'project' && (args[1] === 'get' || args[1] === 'set-config')) {
    const id = encodeURIComponent(args[2]!);
    const editing = args[1] === 'set-config';
    const response = await fetch(`http://127.0.0.1:3001/api/v1/projects/${id}${editing ? '/config' : ''}`, {
      method: editing ? 'PUT' : 'GET',
      ...(editing ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: JSON.parse(args[args.indexOf('--config-json') + 1]!) }) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`AO project ${args[1]} failed: HTTP ${response.status}`);
    return { stdout: JSON.stringify(await response.json()), stderr: '' };
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(file, args, { cwd: options?.cwd, encoding: 'utf8' });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export async function defaultReadLine(question: string, defaultValue = ''): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await readline.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally {
    readline.close();
  }
}

async function commandOrNull(command: InitCommandRunner, file: string, args: string[], cwd: string): Promise<string | null> {
  try {
    return (await command(file, args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

function hasMakeTarget(cwd: string, target: string): boolean {
  const path = resolve(cwd, 'Makefile');
  if (!existsSync(path)) return false;
  return new RegExp(`^${target}:`, 'm').test(readFileSync(path, 'utf8'));
}

function packageJsonScript(cwd: string, script: string): boolean {
  const path = resolve(cwd, 'package.json');
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, unknown> };
    return typeof parsed.scripts?.[script] === 'string';
  } catch {
    return false;
  }
}

function detectTestCommand(cwd: string): string {
  if (hasMakeTarget(cwd, 'test')) return 'make test';
  if (packageJsonScript(cwd, 'test')) return 'npm test';
  if (existsSync(resolve(cwd, 'pyproject.toml'))) return 'pytest';
  return 'npm test';
}

function detectSetupCommand(cwd: string): string | null {
  if (hasMakeTarget(cwd, 'setup')) return 'make setup';
  if (existsSync(resolve(cwd, 'package-lock.json'))) return 'npm ci';
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(resolve(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (existsSync(resolve(cwd, 'uv.lock'))) return 'uv sync';
  return null;
}

function slugFromRemote(remote: string | null): string | undefined {
  if (!remote) return undefined;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match?.[1];
}

function parseYes(value: string): boolean {
  return /^y(?:es)?$/i.test(value.trim());
}

function parseBudget(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 40;
}

function parseAoAgents(output: string | null): Set<string> {
  const found = new Set<string>();
  if (!output) return found;
  try {
    const parsed = JSON.parse(output) as unknown;
    const text = JSON.stringify(parsed).toLowerCase();
    if (text.includes('codex')) found.add('codex');
    if (text.includes('claude-code')) found.add('claude-code');
    return found;
  } catch {
    const text = output.toLowerCase();
    if (text.includes('codex')) found.add('codex');
    if (text.includes('claude-code')) found.add('claude-code');
    return found;
  }
}

function tiersFor(agents: Set<string>) {
  const harness = agents.has('codex') || !agents.has('claude-code') ? 'codex' : 'claude-code';
  const source = harness === 'codex' ? CODEx_TIERS : CLAUDE_TIERS;
  const provider = harness === 'codex' ? 'openai' : 'anthropic';
  return source.map(([name, model, input, cached, output, ceilingFraction]) => ({
    name,
    harness,
    sessionMode: 'tui' as const,
    provider,
    model,
    price: { inputUsdPerMTok: input, cachedInputUsdPerMTok: cached, outputUsdPerMTok: output },
    ceilingFraction,
  }));
}

function withPostCreate(config: unknown, setupCommand: string | null): Record<string, unknown> {
  const base = typeof config === 'object' && config !== null && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {};
  if (!setupCommand) return base;
  const current = Array.isArray(base.postCreate) ? base.postCreate.filter((item): item is string => typeof item === 'string') : [];
  base.postCreate = current.includes(setupCommand) ? current : [...current, setupCommand];
  return base;
}

async function ensureAoProject(input: { command: InitCommandRunner; cwd: string; repoRoot: string; projectId: string; setupCommand: string | null }) {
  const existing = await commandOrNull(input.command, 'ao', ['project', 'get', input.projectId, '--json'], input.cwd);
  if (!existing) {
    await input.command('ao', ['project', 'add', '--path', input.repoRoot, '--id', input.projectId], { cwd: input.cwd });
  }
  const payloadText = (await input.command('ao', ['project', 'get', input.projectId, '--json'], { cwd: input.cwd })).stdout;
  const current = (parseYaml(payloadText) as { project?: { config?: unknown } })?.project?.config ?? {};
  const next = withPostCreate(current, input.setupCommand);
  const postCreateBefore = Array.isArray((current as Record<string, unknown>).postCreate) ? (current as { postCreate: string[] }).postCreate : [];
  const postCreateAfter = Array.isArray(next.postCreate) ? next.postCreate as string[] : [];
  await input.command('ao', ['project', 'set-config', input.projectId, '--config-json', JSON.stringify(next), '--json'], { cwd: input.cwd });
  return { projectCreated: !existing, projectConfigHash: configHash(next), postCreateExisted: Array.isArray((current as Record<string, unknown>).postCreate), postCreateAfterHash: configHash(postCreateAfter),
    addedSetupCommand: input.setupCommand && !postCreateBefore.includes(input.setupCommand) ? input.setupCommand : null };
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const command = options.command ?? defaultCommand;
  const readLine = options.readLine ?? defaultReadLine;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = (await commandOrNull(command, 'git', ['rev-parse', '--show-toplevel'], cwd)) ?? cwd;
  const configPath = resolve(repoRoot, options.configPath ?? 'tally.yaml');
  const recordPath = installRecordPath(configPath);
  if (existsSync(configPath) || existsSync(recordPath)) throw new Error('Tally configuration or install record already exists; init will not overwrite it.');
  const baseBranch = (await commandOrNull(command, 'git', ['branch', '--show-current'], repoRoot)) || 'main';
  const remote = await commandOrNull(command, 'git', ['remote', 'get-url', 'origin'], repoRoot);
  const setupCommand = detectSetupCommand(repoRoot);
  const testCommand = detectTestCommand(repoRoot);
  const budgetUsd = parseBudget(await readLine('Monthly budget in USD', '40'));
  const issueLabel = await readLine('GitHub issue label for Tally tasks', 'tally');
  const neatlogs = parseYes(await readLine('Enable neatlogs traces? y/N', 'N'));
  const entire = parseYes(await readLine('Enable Entire graph/checkpoints? y/N', 'N'));
  const cfoai = parseYes(await readLine('Enable cfo.ai budget integration? y/N', 'N'));
  const agentOutput = await commandOrNull(command, 'ao', ['agent', 'ls', '--refresh', '--json'], cwd);
  const tiers = tiersFor(parseAoAgents(agentOutput));
  const projectId = basename(repoRoot);
  const config = {
    version: 1,
    repo: {
      path: '.',
      ...(slugFromRemote(remote) ? { slug: slugFromRemote(remote) } : {}),
      baseBranch,
      aoProject: projectId,
    },
    test: {
      ...(setupCommand ? { setupCommand } : {}),
      command: testCommand,
      timeoutSec: 900,
    },
    backlog: {
      source: 'github-issues',
      issueLabel,
    },
    tiers,
    ceilings: {
      bySizeUsd: { small: 1.5, medium: 4, large: 10 },
    },
    budget: {
      source: cfoai ? 'cfoai' : 'config',
      usd: budgetUsd,
    },
    concurrency: 3,
    integrations: { neatlogs, entire, cfoai, slack: false },
  };
  const projectChanges = await ensureAoProject({ command, cwd, repoRoot, projectId, setupCommand });
  const configText = stringifyYaml(config);
  const record: InstallRecord = { version: 1, configPath, configHash: contentHash(configText), projectId, ...projectChanges };
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  writeFileSync(configPath, configText, { flag: 'wx' });
  const doctor = await (options.doctor ?? ((path) => runDoctor({ configPath: path })))(configPath);
  return { configPath, projectId, testCommand, setupCommand, baseBranch, tiers: tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`), doctor };
}
