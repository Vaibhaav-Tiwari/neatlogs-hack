import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TallyConfig } from '../schema/index.js';
import { ConfigError } from './config.js';

const execFileAsync = promisify(execFile);

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
  return execFileAsync(file, args);
}

export async function validateRealRunConfig(config: TallyConfig, configPath: string, runner: PreflightRunner = defaultRunner): Promise<void> {
  const problems: string[] = [];
  if (!config.repo.aoProject) problems.push('repo.aoProject is required for real runs so AO knows where to spawn workers');
  const resolvedRepo = repoPath(config, configPath);
  if (!existsSync(resolvedRepo)) problems.push(`repo.path does not exist: ${resolvedRepo}`);
  const resolvedBacklog = backlogPath(config, configPath);
  if (resolvedBacklog && !existsSync(resolvedBacklog)) problems.push(`backlog.file does not exist: ${resolvedBacklog}`);
  if (config.repo.aoProject) {
    try {
      await runner('ao', ['project', 'get', config.repo.aoProject, '--json']);
    } catch {
      problems.push(
        `repo.aoProject "${config.repo.aoProject}" is not registered in AO; fix: ao project add --path ${resolvedRepo} --id ${config.repo.aoProject}`,
      );
    }
  }
  if (problems.length > 0) throw new ConfigError(configPath, problems);
}
