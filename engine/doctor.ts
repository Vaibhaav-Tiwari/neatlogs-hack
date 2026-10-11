import { CommandError, runCommand } from '../adapters/command.js';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkCfoaiConnection } from '../adapters/cfoai.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { checkClaudePostCreate, checkConfiguredWorkerMode, checkSetupPostCreate } from './preflight.js';
import { checkHarness, claudeAllowList } from './harness.js';
import { configuredModelAccessNotice } from './model-access.js';
import { configHash } from './install-record.js';
import { EntireCheckpointRecallAdapter } from '../adapters/entire-recall.js';
import { readAoDaemonStatus } from './ao-status.js';

export type DoctorStatus = 'connected' | 'missing' | 'broken' | 'off' | 'unverified';

export interface DoctorLine {
  product: string;
  status: DoctorStatus;
  detail: string;
  fix: string | null;
}

export function doctorHasFailures(lines: DoctorLine[]): boolean {
  return lines.some((line) => !['connected', 'off', 'unverified'].includes(line.status));
}

export type DoctorRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface DoctorOptions {
  runner?: DoctorRunner;
  env?: Record<string, string>;
  cfoaiCheck?: typeof checkCfoaiConnection;
  configPath?: string;
}

async function commandLine(product: string, runner: DoctorRunner, file: string, args: string[], fix: string): Promise<DoctorLine> {
  try {
    await runner(file, args);
    return { product, status: 'connected', detail: 'ok', fix: null };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const status: DoctorStatus = code === 'ENOENT' ? 'missing' : 'broken';
    return { product, status, detail: e instanceof CommandError ? e.message : status === 'missing' ? `${file} not found` : `${file} failed`, fix: file === 'ao' && status === 'missing' ? 'set TALLY_AO_BIN to the installed AO executable path' : fix };
  }
}

async function aoDaemonLine(runner: DoctorRunner): Promise<DoctorLine> {
  try {
    const status = await readAoDaemonStatus(runner);
    if (status.state === 'running') return { product: 'AO daemon', status: 'connected', detail: status.detail, fix: null };
    return {
      product: 'AO daemon',
      status: 'broken',
      detail: status.detail,
      fix: status.state === 'stopped' ? 'ao start' : 'check the AO installation and run ao status --json',
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const status: DoctorStatus = code === 'ENOENT' ? 'missing' : 'broken';
    return {
      product: 'AO daemon',
      status,
      detail: error instanceof CommandError ? error.message : status === 'missing' ? 'ao not found' : 'ao status failed',
      fix: status === 'missing' ? 'set TALLY_AO_BIN to the installed AO executable path' : 'check the AO installation and run ao status --json',
    };
  }
}

async function aoWorkerModeLine(configPath: string, runner: DoctorRunner): Promise<DoctorLine | null> {
  if (!existsSync(configPath)) return null;
  const config = loadConfig(configPath);
  const projectId = config.repo.aoProject;
  if (!projectId) {
    return {
      product: 'AO worker auto mode',
      status: 'missing',
      detail: 'repo.aoProject is required before Tally can check worker permissions',
      fix: 'add repo.aoProject to tally.yaml',
    };
  }
  try {
    const output = await runner('ao', ['project', 'get', projectId, '--json']);
    const payload = JSON.parse(output.stdout) as { project?: { config?: unknown } };
    const check = checkConfiguredWorkerMode(config, payload.project?.config);
    return {
      product: 'AO worker auto mode',
      status: check.ok ? 'connected' : 'broken',
      detail: check.detail,
      fix: check.ok ? null : check.fix,
    };
  } catch (error) {
    if (error instanceof CommandError && error.code === 'ENOENT') return { product: 'AO worker auto mode', status: 'missing', detail: error.message, fix: 'set TALLY_AO_BIN to the installed AO executable path' };
    return {
      product: 'AO worker auto mode',
      status: 'missing',
      detail: `repo.aoProject "${projectId}" is not registered in AO`,
      fix: `ao project add --path ${config.repo.path} --id ${projectId}`,
    };
  }
}

async function aoSetupPostCreateLine(configPath: string, runner: DoctorRunner): Promise<DoctorLine | null> {
  if (!existsSync(configPath)) return null;
  const config = loadConfig(configPath);
  if (!config.test.setupCommand && !config.tiers.some(tier => tier.harness === 'claude-code')) return null;
  const projectId = config.repo.aoProject;
  if (!projectId) {
    return {
      product: 'AO setup post-create',
      status: 'missing',
      detail: 'repo.aoProject is required before Tally can check setup post-create',
      fix: 'add repo.aoProject to tally.yaml',
    };
  }
  try {
    const output = await runner('ao', ['project', 'get', projectId, '--json']);
    const payload = JSON.parse(output.stdout) as { project?: { config?: unknown } };
    const check = checkClaudePostCreate(config, configPath, payload.project?.config)
      ?? checkSetupPostCreate(projectId, payload.project?.config, config.test.setupCommand)!;
    return {
      product: 'AO setup post-create',
      status: check.ok ? 'connected' : 'broken',
      detail: check.detail,
      fix: check.ok ? null : check.fix,
    };
  } catch (error) {
    if (error instanceof CommandError && error.code === 'ENOENT') return { product: 'AO setup post-create', status: 'missing', detail: error.message, fix: 'set TALLY_AO_BIN to the installed AO executable path' };
    return {
      product: 'AO setup post-create',
      status: 'missing',
      detail: `repo.aoProject "${projectId}" is not registered in AO`,
      fix: `ao project add --path ${config.repo.path} --id ${projectId}`,
    };
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorLine[]> {
  const config = options.configPath && existsSync(options.configPath) ? loadConfig(options.configPath) : null;
  const runner = options.runner ?? ((file, args, commandOptions) => runCommand(file, args, {
    ...commandOptions,
    aoBin: config?.repo.aoBin ? resolve(dirname(options.configPath!), config.repo.aoBin) : undefined,
  }));
  const env = options.env ?? { ...loadEnv(), ...process.env };
  const cfoaiCheck = options.cfoaiCheck ?? checkCfoaiConnection;
  const lines: DoctorLine[] = [];
  const direct = config?.runner === 'direct';
  lines.push(!config || direct
    ? { product: 'AO daemon', status: 'off', detail: !config ? 'runner not selected; choose AO during tally init to use Agent Orchestrator' : 'direct runner; Agent Orchestrator is not required', fix: null }
    : await aoDaemonLine(runner));
  if (options.configPath && !direct) {
    const workerMode = await aoWorkerModeLine(options.configPath, runner);
    if (workerMode) lines.push(workerMode);
    const setupPostCreate = await aoSetupPostCreateLine(options.configPath, runner);
    if (setupPostCreate) lines.push(setupPostCreate);
  }
  if (config) {
    const cwd = resolve(dirname(options.configPath!), config.repo.path);
    for (const harness of new Set(config.tiers.map(tier => tier.harness))) {
      const status = await checkHarness(harness, runner, cwd);
      lines.push({ product: harness === 'claude-code' ? 'Claude Code' : 'Codex', status: !status.installed ? 'missing' : status.signedIn ? 'connected' : 'broken', detail: status.detail, fix: status.installed && status.signedIn ? null : status.fix });
    }
    lines.push({
      product: 'Configured model access',
      status: 'unverified',
      detail: configuredModelAccessNotice(config.tiers),
      fix: 'Check the configured models with the same active accounts/providers; edit tiers[].model in tally.yaml for any model they reject.',
    });
    if (config.tiers.some(tier => tier.harness === 'claude-code')) {
      const approved = config.claudeCode && configHash(config.claudeCode.allow) === configHash(claudeAllowList(config.test));
      lines.push({ product: 'Claude Code allow-list consent', status: approved ? 'connected' : 'missing', detail: approved ? 'Repository consent matches current test/setup commands; worker-local enforcement is a separate check' : 'Claude Code worker allow-list has not been approved for these test/setup commands', fix: approved ? null : 'tally init' });
    }
  }
  lines.push(await commandLine('GitHub CLI', runner, 'gh', ['auth', 'status'], 'gh auth login'));
  const off = (product: string, detail = 'disabled in tally.yaml; not required'): DoctorLine => ({ product, status: 'off', detail, fix: null });
  const notSelected = 'optional integration; not selected until tally init';
  const entireEnabled = config?.integrations.entire === true;
  lines.push(!entireEnabled ? off('Entire CLI', config ? 'disabled in tally.yaml; not required' : notSelected) : await commandLine('Entire CLI', runner, 'entire', ['--version'], 'pipx install entire'));
  lines.push(!entireEnabled ? off('Entire graph plugin', config ? 'disabled in tally.yaml; not required' : notSelected) : await commandLine('Entire graph plugin', runner, 'entire', ['graph', '--help'], 'entire enable'));
  if (entireEnabled) {
    const cwd = resolve(dirname(options.configPath!), config.repo.path);
    const recall = await new EntireCheckpointRecallAdapter({ repoPath: cwd, command: runner }).checkAvailability();
    lines.push({ product: 'Entire checkpoint recall', status: recall.status === 'ok' ? 'connected' : 'broken', detail: recall.detail ?? 'checkpoint search available', fix: recall.status === 'ok' ? null : 'check Entire repository mirroring and account access; entire enable alone does not enable hosted search' });
    try {
      const output = await runner('entire', ['status', '--json'], { cwd });
      const enabled = JSON.parse(output.stdout).enabled === true;
      lines.push({ product: 'Entire repository', status: enabled ? 'connected' : 'missing', detail: enabled ? `Entire is enabled in ${cwd}` : `Entire is not enabled in ${cwd}`, fix: enabled ? null : `cd ${JSON.stringify(cwd)} && entire enable` });
    } catch (error) {
      lines.push({ product: 'Entire repository', status: 'broken', detail: error instanceof Error ? error.message : 'Entire status failed', fix: `cd ${JSON.stringify(cwd)} && entire enable` });
    }
  }
  lines.push(
    config?.integrations.neatlogs !== true ? off('neatlogs key', config ? 'disabled in tally.yaml; not required' : notSelected) : env.NEATLOGS_API_KEY
      ? { product: 'neatlogs key', status: 'connected', detail: 'NEATLOGS_API_KEY is set', fix: null }
      : {
          product: 'neatlogs key',
          status: 'missing',
          detail: 'NEATLOGS_API_KEY is missing from ~/.tally/.env',
          fix: "mkdir -p ~/.tally && printf 'NEATLOGS_API_KEY=...\\n' >> ~/.tally/.env",
        },
  );
  const cfoaiEnabled = config?.integrations.cfoai === true || config?.budget.source === 'cfoai';
  if (!cfoaiEnabled) {
    lines.push(off('cfo.ai', config ? 'disabled in tally.yaml; not required' : notSelected));
    return lines;
  }
  const cfoai = await cfoaiCheck();
  lines.push({
    product: 'cfo.ai',
    status: cfoai.status === 'ok' ? 'connected' : 'missing',
    detail: cfoai.detail ?? (cfoai.status === 'ok' ? 'Tally cached token works' : 'Tally cfo.ai token is missing or unusable'),
    fix: cfoai.status === 'ok' ? null : 'tally login cfoai',
  });
  return lines;
}
