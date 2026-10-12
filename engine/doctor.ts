import { CommandError, runCommand } from '../adapters/command.js';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkCfoaiConnection } from '../adapters/cfoai.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { checkClaudePostCreate, checkConfiguredWorkerMode, checkSetupPostCreate } from './preflight.js';
import { checkHarness, claudeAllowList } from './harness.js';
import { configHash } from './install-record.js';
import { EntireCheckpointRecallAdapter } from '../adapters/entire-recall.js';
import { readAoDaemonStatus } from './ao-status.js';

export type DoctorStatus = 'connected' | 'missing' | 'broken' | 'off' | 'unverified' | 'unavailable';

export interface DoctorLine {
  product: string;
  status: DoctorStatus;
  detail: string;
  fix: string | null;
}

export function doctorHasFailures(lines: DoctorLine[]): boolean {
  return lines.some((line) => !['connected', 'off', 'unverified', 'unavailable'].includes(line.status));
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
    ? { product: 'AO daemon', status: 'off', detail: !config ? 'Runner not selected. Choose AO during tally init to use Agent Orchestrator.' : 'Direct runner selected. Agent Orchestrator is not required.', fix: null }
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
    if (config.tiers.some(tier => tier.harness === 'claude-code')) {
      const approved = config.claudeCode && configHash(config.claudeCode.allow) === configHash(claudeAllowList(config.test));
      lines.push({ product: 'Claude Code allow-list consent', status: approved ? 'connected' : 'missing', detail: approved ? 'Repository consent matches current test/setup commands. Worker-local enforcement is a separate check.' : 'Claude Code worker allow-list has not been approved for these test/setup commands.', fix: approved ? null : 'tally init' });
    }
  }
  lines.push(await commandLine('GitHub CLI', runner, 'gh', ['auth', 'status'], 'gh auth login'));
  const off = (product: string, detail = 'Disabled in tally.yaml. This integration is not required.'): DoctorLine => ({ product, status: 'off', detail, fix: null });
  const notSelected = 'Not configured.';
  const disabled = 'Disabled in tally.yaml. This integration is not required.';
  const entireEnabled = config?.integrations.entire === true;
  lines.push(!entireEnabled ? off('Entire CLI', config ? disabled : notSelected) : await commandLine('Entire CLI', runner, 'entire', ['--version'], 'Install from https://docs.entire.io/installation, then rerun tally init'));
  lines.push(!entireEnabled ? off('Entire graph plugin', config ? disabled : notSelected) : await commandLine('Entire graph plugin', runner, 'entire', ['graph', '--help'], 'entire plugin install graph'));
  if (entireEnabled) {
    const cwd = resolve(dirname(options.configPath!), config.repo.path);
    const recall = await new EntireCheckpointRecallAdapter({ repoPath: cwd, command: runner }).checkAvailability();
    const detail = recall.detail ?? 'checkpoint search available';
    const repositoryNotAvailable = /no matching repositories|not mirrored|not accessible in the current account/i.test(detail);
    lines.push({
      product: 'Entire checkpoint recall',
      status: recall.status === 'ok' ? 'connected' : repositoryNotAvailable ? 'unavailable' : 'broken',
      detail: recall.status === 'ok' ? detail : `${detail} Hosted recall is optional. Local capture and normal task runs remain available.`,
      fix: recall.status === 'ok' ? null : repositoryNotAvailable
        ? 'Optional: make this repository accessible to Entire to enable hosted checkpoint recall.'
        : 'Check Entire checkpoint search and account access.',
    });
    if (!config.repo.slug) {
      lines.push({
        product: 'Entire Web mirror',
        status: 'unavailable',
        detail: 'repo.slug is not configured, so Tally cannot check whether this GitHub repository is mirrored in Entire Web. Local checkpoint capture is separate.',
        fix: 'Set repo.slug in tally.yaml if you want Tally to check or create an Entire Web mirror.',
      });
    } else {
      try {
        const output = await runner('entire', ['repo', 'mirror', 'list', '--json', '--mirrored', '--name', config.repo.slug], { cwd });
        const parsed: unknown = JSON.parse(output.stdout);
        const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
          ? (parsed as { items: unknown[] }).items : [];
        const repo = `/gh/${config.repo.slug}`;
        const mirror = records.find((value): value is { repo?: unknown; placements?: { cluster?: unknown; status?: unknown }[] } =>
          !!value && typeof value === 'object' && (value as { repo?: unknown }).repo === repo);
        const ready = mirror?.placements?.filter(placement => placement.status === 'ready') ?? [];
        if (ready.length) {
          const clusters = ready.map(placement => typeof placement.cluster === 'string' ? placement.cluster : null).filter(Boolean);
          lines.push({
            product: 'Entire Web mirror',
            status: 'connected',
            detail: `GitHub repository mirror is ready${clusters.length ? ` on ${clusters.join(', ')}` : ''}.`,
            fix: null,
          });
        } else {
          lines.push({
            product: 'Entire Web mirror',
            status: 'unavailable',
            detail: `No ready Entire Web mirror found for ${repo}. Local checkpoint capture and Git-remote checkpoint sync are separate.`,
            fix: `Optional: entire repo mirror add ${repo}`,
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'mirror lookup failed';
        lines.push({
          product: 'Entire Web mirror',
          status: 'unavailable',
          detail: `Could not verify Entire Web mirror status: ${reason}. Local checkpoint capture is separate.`,
          fix: `Optional: entire repo mirror list --name ${config.repo.slug}`,
        });
      }
    }
    try {
      const output = await runner('entire', ['status', '--json'], { cwd });
      const enabled = JSON.parse(output.stdout).enabled === true;
      lines.push({ product: 'Entire repository', status: enabled ? 'connected' : 'missing', detail: enabled ? `Entire is enabled in ${cwd}` : `Entire is not enabled in ${cwd}`, fix: enabled ? null : 'rerun tally init and choose Entire' });
    } catch (error) {
      lines.push({ product: 'Entire repository', status: 'broken', detail: error instanceof Error ? error.message : 'Entire status failed', fix: 'rerun tally init and choose Entire' });
    }
  }
  lines.push(
    config?.integrations.neatlogs !== true ? off('Neatlogs key', config ? disabled : notSelected) : env.NEATLOGS_API_KEY
      ? { product: 'Neatlogs key', status: 'connected', detail: 'NEATLOGS_API_KEY is set', fix: null }
      : {
          product: 'neatlogs key',
          status: 'missing',
          detail: 'No project key is configured.',
          fix: 'Create a project key at https://app.neatlogs.com/settings/api-keys, then run tally init',
        },
  );
  const cfoaiEnabled = config?.integrations.cfoai === true || config?.budget.source === 'cfoai';
  if (!cfoaiEnabled) {
    lines.push(off('cfo.ai', config ? disabled : notSelected));
    return lines;
  }
  const cfoai = await cfoaiCheck({ config: config?.budget.cfoai });
  lines.push({
    product: 'cfo.ai',
    status: cfoai.status === 'ok' ? 'connected' : 'missing',
    detail: cfoai.detail ?? (cfoai.status === 'ok' ? 'Tally cached token works' : 'Tally cfo.ai token is missing or unusable'),
    fix: cfoai.status === 'ok' ? null : 'tally login cfoai',
  });
  if (config?.budget.cfoai?.publishRunContext) {
    lines.push({
      product: 'cfo.ai Ari task context',
      status: cfoai.status === 'ok' ? 'connected' : 'missing',
      detail: cfoai.status === 'ok' ? 'Organization-memory tool schema is available. Tally checks each report before sending it.' : 'Ari task-context publishing needs a working cfo.ai connection and organization-memory tool.',
      fix: cfoai.status === 'ok' ? null : 'tally login cfoai',
    });
  } else {
    lines.push(off('cfo.ai Ari task context', 'Off. Budget and spend tables can still be used.'));
  }
  return lines;
}
