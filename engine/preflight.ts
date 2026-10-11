import { existsSync } from 'node:fs';
import { CommandError, runCommand } from '../adapters/command.js';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { TallyConfig } from '../schema/index.js';
import { ConfigError } from './config.js';

export type PreflightRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function configRelative(configPath: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}

export function repoPath(config: TallyConfig, configPath: string): string {
  return configRelative(configPath, config.repo.path);
}

export function backlogPath(config: TallyConfig, configPath: string): string | null {
  if (config.backlog.source !== 'file' || config.backlog.file === undefined) return null;
  return configRelative(configPath, config.backlog.file);
}

function defaultRunner(file: string, args: string[]) {
  return runCommand(file, args);
}

interface AoProjectResponse {
  project?: {
    config?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function withWorkerAutoMode(config: unknown): Record<string, unknown> {
  const base = isRecord(config) ? { ...config } : {};
  const worker = isRecord(base.worker) ? { ...base.worker } : {};
  const agentConfig = isRecord(worker.agentConfig) ? { ...worker.agentConfig } : {};
  agentConfig.permissions = 'auto';
  worker.agentConfig = agentConfig;
  base.worker = worker;
  return base;
}

function quoteJsonForShell(value: unknown): string {
  return quoteShell(JSON.stringify(value));
}

export function workerAutoModeFixCommand(projectId: string, projectConfig: unknown): string {
  const fixed = withWorkerAutoMode(projectConfig);
  return `ao project set-config ${projectId} --config-json ${quoteJsonForShell(fixed)}`;
}

export function workerPermissionMode(projectConfig: unknown): string | null {
  if (!isRecord(projectConfig)) return null;
  const worker = isRecord(projectConfig.worker) ? projectConfig.worker : {};
  const workerAgentConfig = isRecord(worker.agentConfig) ? worker.agentConfig : {};
  const workerPermission = workerAgentConfig.permissions;
  if (typeof workerPermission === 'string') return workerPermission;
  return null;
}

export interface WorkerPermissionCheck {
  ok: boolean;
  mode: string | null;
  detail: string;
  fix: string;
}

export function checkWorkerAutoMode(projectId: string, projectConfig: unknown): WorkerPermissionCheck {
  const mode = workerPermissionMode(projectConfig);
  const fix = workerAutoModeFixCommand(projectId, projectConfig);
  if (mode === 'auto') {
    return { ok: true, mode, detail: 'worker permission mode is auto', fix };
  }
  const label = mode ?? 'unset';
  return {
    ok: false,
    mode,
    detail: `worker permission mode is ${label}; unattended Tally workers can stall before setup, edits, tests, or commits`,
    fix,
  };
}

function postCreateCommands(projectConfig: unknown): string[] {
  if (!isRecord(projectConfig)) return [];
  const value = projectConfig.postCreate;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function withPostCreateCommand(config: unknown, command: string): Record<string, unknown> {
  const base = isRecord(config) ? { ...config } : {};
  const commands = postCreateCommands(base);
  base.postCreate = commands.includes(command) ? commands : [...commands, command];
  return base;
}

export function setupPostCreateFixCommand(projectId: string, projectConfig: unknown, setupCommand: string): string {
  return `ao project set-config ${projectId} --config-json ${quoteJsonForShell(withPostCreateCommand(projectConfig, setupCommand))}`;
}

export interface SetupPostCreateCheck {
  ok: boolean;
  detail: string;
  fix: string;
}

export function checkSetupPostCreate(projectId: string, projectConfig: unknown, setupCommand: string | undefined): SetupPostCreateCheck | null {
  if (!setupCommand) return null;
  const fix = setupPostCreateFixCommand(projectId, projectConfig, setupCommand);
  if (postCreateCommands(projectConfig).includes(setupCommand)) {
    return { ok: true, detail: `post-create runs setup command: ${setupCommand}`, fix };
  }
  return {
    ok: false,
    detail: `test.setupCommand is "${setupCommand}", but AO project postCreate does not run it before the worker starts`,
    fix,
  };
}

function sessionModeProblems(config: TallyConfig): string[] {
  return config.tiers.flatMap((tier, index) => {
    if (tier.sessionMode === 'tui') return [];
    const path = `tiers[${index}].sessionMode`;
    if (tier.sessionMode === 'chat') {
      return [`${path} is "chat"; real Tally workers need sessionMode: tui so unattended shell work does not route through chat approval prompts`];
    }
    return [`${path} is required for real runs; set sessionMode: tui after proving the harness can run unattended`];
  });
}

function parseAoProject(stdout: string): AoProjectResponse {
  return JSON.parse(stdout) as AoProjectResponse;
}

export async function validateRealRunConfig(config: TallyConfig, configPath: string, runner: PreflightRunner = defaultRunner): Promise<void> {
  if (runner === defaultRunner) runner = (file, args) => runCommand(file, args, { aoBin: config.repo.aoBin ? configRelative(configPath, config.repo.aoBin) : undefined });
  const problems: string[] = [];
  if (!config.repo.aoProject) problems.push('repo.aoProject is required for real runs so AO knows where to spawn workers');
  const resolvedRepo = repoPath(config, configPath);
  if (!existsSync(resolvedRepo)) problems.push(`repo.path does not exist: ${resolvedRepo}`);
  const resolvedBacklog = backlogPath(config, configPath);
  if (resolvedBacklog && !existsSync(resolvedBacklog)) problems.push(`backlog.file does not exist: ${resolvedBacklog}`);
  problems.push(...sessionModeProblems(config));
  if (config.repo.aoProject) {
    let project: AoProjectResponse | null = null;
    try {
      project = parseAoProject((await runner('ao', ['project', 'get', config.repo.aoProject, '--json'])).stdout);
    } catch (error) {
      if (error instanceof CommandError) throw error;
      problems.push(
        `repo.aoProject "${config.repo.aoProject}" is not registered in AO; fix: ao project add --path ${resolvedRepo} --id ${config.repo.aoProject}`,
      );
    }
    if (project) {
      const permission = checkWorkerAutoMode(config.repo.aoProject, project.project?.config);
      if (!permission.ok) {
        problems.push(`${permission.detail}; fix: ${permission.fix}`);
      }
      const setup = checkSetupPostCreate(config.repo.aoProject, project.project?.config, config.test.setupCommand);
      if (setup && !setup.ok) {
        problems.push(`${setup.detail}; fix: ${setup.fix}`);
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(configPath, problems);
}
