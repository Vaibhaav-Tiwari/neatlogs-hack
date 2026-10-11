import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { contentHash, configHash, installRecordPath, type InstallRecord } from './install-record.js';
import { applyInitTransaction, finishInitTransaction, pendingInitPath, readPendingInit, type InitTransaction } from './init-transaction.js';
import { validateConfig, type TallyConfig } from '../schema/index.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runDoctor, type DoctorLine } from './doctor.js';
import { tierPriceNote } from './pricing.js';
import { CommandError, resolveAoBinary, runCommand } from '../adapters/command.js';
import { checkCfoaiConnection } from '../adapters/cfoai.js';
import { loadEnv } from './env.js';
import { configureIntegrations } from '../onboarding/index.js';
import { loadConfig } from './config.js';
import { applyReinit, finishReinit, prepareReinit, readReinit, reinitPath } from './reinit.js';

export interface InitCommandResult {
  stdout: string;
  stderr: string;
}

export class InitError extends Error {}

export type InitCommandRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<InitCommandResult>;
export type PromptReader = (question: string, defaultValue?: string) => Promise<string>;

export interface InitOptions {
  cwd?: string;
  configPath?: string;
  command?: InitCommandRunner;
  readLine?: PromptReader;
  doctor?: (configPath: string) => Promise<DoctorLine[]>;
  print?: (line: string) => void;
  yes?: boolean;
  dryRun?: boolean;
  env?: Record<string, string>;
  cfoaiCheck?: typeof checkCfoaiConnection;
  onboarding?: typeof configureIntegrations;
}

export interface InitResult {
  applied: boolean;
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
  ['middle', 'gpt-5.6-terra', 2, 0.2, 12, 0.5],
  ['top', 'gpt-5.6-sol', 4, 0.4, 20, 1],
] as const;

const CLAUDE_TIERS = [
  ['cheap', 'claude-haiku-4-5-20251001', 1, 0.1, 5, 0.2],
  ['middle', 'claude-sonnet-5-5', 2, 0.2, 10, 0.5],
  ['top', 'claude-opus-5-5', 4, 0.4, 20, 1],
] as const;

export async function defaultCommand(file: string, args: string[], options?: { cwd?: string; aoBin?: string }): Promise<InitCommandResult> {
  if (file === 'ao') resolveAoBinary(options);
  // The CLI config mirror drops fields such as effort; use the full daemon object.
  if (file === 'ao' && args[0] === 'project' && (args[1] === 'get' || args[1] === 'set-config')) {
    const id = encodeURIComponent(args[2]!);
    const editing = args[1] === 'set-config';
    const response = await fetch(`http://127.0.0.1:3001/api/v1/projects/${id}${editing ? '/config' : ''}`, {
      method: editing ? 'PUT' : 'GET',
      ...(editing ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: JSON.parse(args[args.indexOf('--config-json') + 1]!) }) } : {}),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new InitError('AO project API could not be reached; start AO and retry.'); });
    if (!response.ok) throw new InitError(`AO project ${args[1]} failed: HTTP ${response.status}; check AO is running before retrying.`);
    return { stdout: JSON.stringify(await response.json()), stderr: '' };
  }
  return runCommand(file, args, options);
}

async function projectOrNull(command: InitCommandRunner, projectId: string, cwd: string): Promise<string | null> {
  try { return (await command('ao', ['project', 'get', projectId, '--json'], { cwd })).stdout; }
  catch (error) {
    if (error instanceof Error && /missing project|not found|HTTP 404/i.test(error.message)) return null;
    throw error;
  }
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
  } catch (error) {
    if (file === 'ao' && error instanceof CommandError) throw error;
    return null;
  }
}

function hasMakeTarget(cwd: string, target: string): boolean {
  const path = resolve(cwd, 'Makefile');
  if (!existsSync(path)) return false;
  return new RegExp(`^${target}[ \\t]*:`, 'm').test(readFileSync(path, 'utf8'));
}

function packageJsonScript(cwd: string, script: string): boolean {
  const path = resolve(cwd, 'package.json');
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, unknown> };
    const value = parsed.scripts?.[script];
    return typeof value === 'string' && value.trim().length > 0;
  } catch {
    return false;
  }
}

function detectTestCommand(cwd: string): string | null {
  if (hasMakeTarget(cwd, 'test')) return 'make test';
  if (packageJsonScript(cwd, 'test')) return 'npm test';
  for (const [file, section] of [
    ['pyproject.toml', 'tool.pytest.ini_options'], ['pytest.ini', 'pytest'],
    ['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest'],
  ] as const) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (text.split('\n').some((line) => line.trim().split('#')[0]!.trim() === `[${section}]`)) return 'pytest';
  }
  if (existsSync(resolve(cwd, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(resolve(cwd, 'go.mod'))) return 'go test ./...';
  return null;
}

function detectSetupCommand(cwd: string): string | null {
  if (hasMakeTarget(cwd, 'setup')) return 'make setup';
  if (packageJsonScript(cwd, 'setup')) return 'npm run setup';
  if (existsSync(resolve(cwd, 'package.json'))) {
    if (existsSync(resolve(cwd, 'package-lock.json'))) return 'npm ci';
    if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
    if (existsSync(resolve(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  }
  if (existsSync(resolve(cwd, 'pyproject.toml')) && existsSync(resolve(cwd, 'uv.lock'))) return 'uv sync';
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
    const parsed = JSON.parse(output) as { installed?: unknown };
    // AO also lists every supported harness; those are not evidence of installation.
    const agents = parsed.installed;
    if (!Array.isArray(agents)) return found;
    for (const agent of agents) {
      if (agent && typeof agent === 'object' && agent.installed !== false &&
          (agent.id === 'codex' || agent.id === 'claude-code')) found.add(agent.id);
    }
  } catch {
    // An unavailable or malformed installation report must not invent a harness.
  }
  return found;
}

function tiersFor(agents: Set<string>) {
  if (!agents.has('codex') && !agents.has('claude-code')) {
    throw new InitError('No installed Codex or Claude Code agent detected. Install and sign in to one, then check `ao agent ls --refresh --json` before running tally init.');
  }
  const harness = agents.has('codex') ? 'codex' : 'claude-code';
  const source = harness === 'codex' ? CODEx_TIERS : CLAUDE_TIERS;
  const provider = harness === 'codex' ? 'openai' : 'anthropic';
  return source.map(([name, model, input, cached, output, ceilingFraction]) => ({
    name,
    harness,
    sessionMode: 'tui' as const,
    provider,
    model,
    price: { inputUsdPerMTok: input, cachedInputUsdPerMTok: cached, outputUsdPerMTok: output },
    priceNote: tierPriceNote({ model, provider, price: { inputUsdPerMTok: input, cachedInputUsdPerMTok: cached, outputUsdPerMTok: output } }),
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

async function initPrerequisites(config: TallyConfig, command: InitCommandRunner, cwd: string, options: InitOptions): Promise<void> {
  await command('ao', ['status'], { cwd });
  await command('git', ['--version'], { cwd });
  await command('gh', ['auth', 'status'], { cwd });
  const env = options.env ?? { ...loadEnv(), ...process.env };
  if (config.integrations.neatlogs && !env.NEATLOGS_API_KEY) throw new InitError('neatlogs was requested but NEATLOGS_API_KEY is missing; add it to ~/.tally/.env before rerunning init; nothing was changed.');
  if (config.integrations.cfoai) {
    const status = await (options.cfoaiCheck ?? checkCfoaiConnection)();
    if (status.status !== 'ok') throw new InitError('cfo.ai was requested but is not connected; run tally login cfoai, then rerun init; nothing was changed.');
  }
  if (config.integrations.entire) {
    await command('entire', ['--version'], { cwd });
    await command('entire', ['graph', '--help'], { cwd });
    const status = JSON.parse((await command('entire', ['status', '--json'], { cwd })).stdout);
    if (status.enabled !== true) throw new InitError(`Entire was requested but is not enabled in ${cwd}; run cd ${JSON.stringify(cwd)} && entire enable, review its repository/hook changes and trust the harness hooks, then rerun init; nothing was changed.`);
  }
}

async function finishInit(options: InitOptions, transaction: InitTransaction, command: InitCommandRunner, recordPath: string): Promise<DoctorLine[]> {
  await applyInitTransaction(transaction, command, recordPath);
  try {
    const doctor = await (options.doctor ?? ((path) => runDoctor({ configPath: path })))(transaction.configPath);
    finishInitTransaction(transaction.configPath);
    return doctor;
  } catch (error) {
    throw new InitError(`Init configured AO and wrote ${transaction.configPath} and ${recordPath}, but doctor failed: ${error instanceof Error ? error.message : 'unknown error'}; rerun tally init --config ${JSON.stringify(transaction.configPath)} to resume from ${pendingInitPath(transaction.configPath)}; files will not be overwritten.`);
  }
}

async function reconfigureInit(options: InitOptions, configPath: string, print: (line: string) => void, readLine: PromptReader): Promise<InitResult> {
  const pending = readReinit(configPath);
  const before = pending ? parseYaml(pending.beforeConfig) as TallyConfig : loadConfig(configPath);
  const config = pending ? parseYaml(pending.afterConfig) as TallyConfig : structuredClone(before);
  if (!validateConfig(before).ok || !validateConfig(config).ok) throw new InitError('Re-init recovery configuration is invalid; no changes made.');
  if (!pending) {
    for (const name of ['neatlogs', 'entire', 'cfoai'] as const) {
      const label = name === 'cfoai' ? 'cfo.ai' : name === 'entire' ? 'Entire' : name;
      config.integrations[name] = parseYes(await readLine(`Enable ${label} integration? y/N`, before.integrations[name] ? 'y' : 'N'));
    }
  }
  const result = { configPath, projectId: config.repo.aoProject ?? '', testCommand: config.test.command, setupCommand: config.test.setupCommand ?? null, baseBranch: config.repo.baseBranch, tiers: config.tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`) };
  if (!pending && configHash(config) === configHash(before)) {
    print('No changes proposed; existing configuration and installation ownership are unchanged.');
    return { ...result, applied: false, doctor: [] };
  }
  const command: InitCommandRunner = options.command ?? ((file, args, commandOptions) => defaultCommand(file, args, { ...commandOptions, aoBin: config.repo.aoBin ? resolve(dirname(configPath), config.repo.aoBin) : undefined }));
  const targetRepo = resolve(dirname(configPath), config.repo.path);
  await initPrerequisites(config, command, targetRepo, options);
  const plan = pending ?? prepareReinit(configPath, stringifyYaml(config));
  print(`Tally re-init proposed diff for ${configPath}:`);
  for (const key of Object.keys(config) as (keyof TallyConfig)[]) {
    if (configHash(before[key]) !== configHash(config[key])) {
      print(`- ${key}: ${JSON.stringify(before[key])}`);
      print(`+ ${key}: ${JSON.stringify(config[key])}`);
    }
  }
  print(`Preserve all other settings; ${plan.beforeRecord === null ? 'no installation ownership record will be created' : 'preserve installation ownership and update only its config hash'}. AO project, setup hooks and worker permissions will not change.`);
  if (pending) print(`Resume interrupted re-init from ${reinitPath(configPath)}.`);
  if (options.dryRun || (!options.yes && !parseYes(await readLine('Apply these changes? y/N', 'N')))) return { ...result, applied: false, doctor: [] };
  applyReinit(plan);
  try {
    const doctor = await (options.doctor ?? ((path) => runDoctor({ configPath: path })))(configPath);
    finishReinit(configPath);
    return { ...result, applied: true, doctor };
  } catch (error) {
    throw new InitError(`Re-init updated ${configPath} and preserved installation ownership, but doctor failed: ${error instanceof Error ? error.message : 'unknown error'}; AO settings were unchanged; rerun tally init --config ${JSON.stringify(configPath)} to resume safely.`);
  }
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const command = options.command ?? defaultCommand;
  const print = options.print ?? console.log;
  const readLine = options.readLine ?? (options.yes || options.dryRun ? async (_question: string, defaultValue = '') => defaultValue : defaultReadLine);
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = (await commandOrNull(command, 'git', ['rev-parse', '--show-toplevel'], cwd)) ?? cwd;
  const configPath = resolve(repoRoot, options.configPath ?? 'tally.yaml');
  const recordPath = installRecordPath(configPath);
  const pending = readPendingInit(configPath);
  if (pending) {
    const saved = parseYaml(pending.configText) as TallyConfig;
    const validation = validateConfig(saved);
    if (!validation.ok || resolve(pending.repoRoot) !== resolve(repoRoot)) throw new InitError('Init recovery configuration is invalid or belongs to a different repository; no changes made.');
    const resumeCommand: InitCommandRunner = options.command ?? ((file, args, commandOptions) => defaultCommand(file, args, { ...commandOptions, aoBin: saved.repo.aoBin ? resolve(dirname(configPath), saved.repo.aoBin) : undefined }));
    try { await initPrerequisites(saved, resumeCommand, repoRoot, options); }
    catch (error) { throw new InitError(`Incomplete init remains at ${pendingInitPath(configPath)}; ${configPath} ${existsSync(configPath) ? 'exists' : 'was not written'}, ${recordPath} ${existsSync(recordPath) ? 'exists' : 'was not written'}; no additional changes made: ${error instanceof Error ? error.message : 'prerequisites failed'}; fix the prerequisite and rerun tally init --config ${JSON.stringify(configPath)}.`); }
    print(`Resume incomplete init from ${pendingInitPath(configPath)}; preserve matching files and existing AO settings.\n${pending.configText}`);
    print(`AO project ${pending.record.projectId}; setup entry: ${pending.record.addedSetupCommand ?? 'none'}; worker allow-list: not installed; no global harness settings changed.`);
    const result = { configPath, projectId: pending.record.projectId, testCommand: saved.test.command, setupCommand: saved.test.setupCommand ?? null, baseBranch: saved.repo.baseBranch, tiers: saved.tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`) };
    if (options.dryRun || (!options.yes && !parseYes(await readLine('Resume these changes? y/N', 'N')))) return { ...result, applied: false, doctor: [] };
    return { ...result, applied: true, doctor: await finishInit(options, pending, resumeCommand, recordPath) };
  }
  if (existsSync(configPath) || readReinit(configPath)) return reconfigureInit(options, configPath, print, readLine);
  if (existsSync(recordPath)) throw new InitError(`An install record exists without ${configPath}; preserve it and use tally uninstall --config ${JSON.stringify(configPath)} to remove the owned partial installation before retrying.`);
  const baseBranch = (await commandOrNull(command, 'git', ['branch', '--show-current'], repoRoot)) || 'main';
  const remote = await commandOrNull(command, 'git', ['remote', 'get-url', 'origin'], repoRoot);
  let testCommand = detectTestCommand(repoRoot);
  if (!testCommand) {
    const explanation = 'No test command found. Tally cannot verify work without a test command; provide a shell command that checks the work. No configuration or AO settings have been changed.';
    print(explanation);
    if (options.yes || options.dryRun) throw new InitError(explanation);
    testCommand = (await readLine('Test command (shell command)', '')).trim();
    if (!testCommand) throw new InitError(explanation);
  }
  let setupCommand = detectSetupCommand(repoRoot);
  if (!setupCommand) {
    print('No setup command found. Leave it blank if no environment setup is needed; Tally will not invent an install command.');
    if (!options.yes && !options.dryRun) setupCommand = (await readLine('Setup command (shell command; optional)', '')).trim() || null;
  }
  const budgetUsd = parseBudget(await readLine('Monthly budget in USD', '40'));
  const issueLabel = await readLine('GitHub issue label for Tally tasks', 'tally');
  const neatlogs = parseYes(await readLine('Enable neatlogs traces? y/N', 'N'));
  const entire = parseYes(await readLine('Enable Entire graph/checkpoints? y/N', 'N'));
  const cfoai = parseYes(await readLine('Enable cfo.ai budget integration? y/N', 'N'));
  const agentOutput = await commandOrNull(command, 'ao', ['agent', 'ls', '--refresh', '--json'], cwd);
  const agents = parseAoAgents(agentOutput);
  const tiers = tiersFor(agents);
  print(`Installed coding agents detected: ${[...agents].join(', ')}. Proposing ${tiers[0]!.harness} tiers.`);
  if (!agents.has('codex')) print('Codex is not installed; proposing tiers for the installed Claude Code agent instead.');
  const projectId = basename(repoRoot);
  const config: TallyConfig = {
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
  if (!options.dryRun) await (options.onboarding ?? configureIntegrations)({ config, repoRoot, ui: {
    print,
    confirm: async (question) => !options.yes && parseYes(await readLine(`${question} y/N`, 'N')),
    select: async (question, choices) => {
      if (options.yes) return null;
      choices.forEach((choice, index) => print(`${index + 1}. ${choice}`));
      const value = (await readLine(`${question}; enter a number, or blank to skip`, '')).trim();
      const index = Number(value) - 1;
      return /^\d+$/.test(value) && index >= 0 && index < choices.length ? index : null;
    },
  } });
  const validation = validateConfig(config);
  if (!validation.ok) throw new InitError(`Proposed configuration is invalid: ${validation.errors.join('; ')}; nothing was changed.`);
  await initPrerequisites(config, command, repoRoot, options);
  const existingProject = await projectOrNull(command, projectId, cwd);
  const existingProjectPath = existingProject ? (JSON.parse(existingProject) as { project?: { path?: string } }).project?.path : undefined;
  if (existingProjectPath && resolve(existingProjectPath) !== resolve(repoRoot)) throw new InitError(`AO project ${projectId} belongs to ${existingProjectPath}, not ${repoRoot}; choose a distinct project id before init; nothing was changed.`);
  const currentProjectConfig = existingProject ? (parseYaml(existingProject) as { project?: { config?: unknown } })?.project?.config ?? {} : {};
  const nextProjectConfig = withPostCreate(currentProjectConfig, setupCommand);
  print('Tally init proposed changes:');
  print(`Create ${configPath}:\n${stringifyYaml(config)}`);
  print(`Create ${recordPath}: installation ownership record for uninstall.`);
  print(`${existingProject ? 'Update' : 'Register'} AO project ${projectId} at ${repoRoot}; preserve all existing config fields.`);
  print(`AO post-create entries: ${JSON.stringify(nextProjectConfig.postCreate ?? [])}`);
  print('Worker allow-list: not installed; scoped enforcement is not available through the current AO worker launch API.');
  print('Requested worker rules (not yet enforced):');
  print('- Edit files in the worker\'s own worktree.');
  print(`- Run the configured test command: ${testCommand}`);
  print('- Run git add and git commit.');
  print('- No git push, network access, or installs. Tally publishes.');
  print('Integration connection changes require their own explicit approval; the config proposal contains no credentials.');
  const result = { configPath, projectId, testCommand, setupCommand, baseBranch, tiers: tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`), doctor: [] as DoctorLine[] };
  if (options.dryRun || (!options.yes && !parseYes(await readLine('Apply these changes? y/N', 'N')))) {
    return { ...result, applied: false };
  }
  const configText = stringifyYaml(config);
  const before = currentProjectConfig as Record<string, unknown>;
  const postCreateBefore = Array.isArray(before.postCreate) ? before.postCreate as string[] : [];
  const record: InstallRecord = { version: 1, configPath, configHash: contentHash(configText), projectId,
    projectCreated: !existingProject, projectConfigHash: configHash(nextProjectConfig),
    postCreateExisted: Array.isArray(before.postCreate), postCreateAfterHash: configHash(nextProjectConfig.postCreate ?? []),
    addedSetupCommand: setupCommand && !postCreateBefore.includes(setupCommand) ? setupCommand : null };
  const doctor = await finishInit(options, { version: 1, repoRoot, configPath, configText, beforeProjectConfigHash: configHash(currentProjectConfig), record }, command, recordPath);
  return { ...result, applied: true, doctor };
}
