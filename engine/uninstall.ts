import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultCommand, defaultReadLine, type InitCommandRunner, type PromptReader } from './init.js';
import { configHash, contentHash, installRecordPath, type InstallRecord } from './install-record.js';
import { parse as parseYaml } from 'yaml';

export interface UninstallOptions {
  configPath?: string;
  command?: InitCommandRunner;
  readLine?: PromptReader;
  print?: (line: string) => void;
}

export async function runUninstall(options: UninstallOptions = {}): Promise<{ removed: boolean; items: string[] }> {
  const configPath = resolve(options.configPath ?? 'tally.yaml');
  const recordPath = installRecordPath(configPath);
  if (!existsSync(recordPath)) throw new Error('No Tally install record found; refusing to remove untracked files or AO settings.');
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as InstallRecord;
  if (record.version !== 1 || record.configPath !== configPath || typeof record.projectId !== 'string'
    || typeof record.postCreateAfterHash !== 'string' || typeof record.postCreateExisted !== 'boolean') throw new Error('Invalid Tally install record.');
  if (existsSync(configPath) && contentHash(readFileSync(configPath, 'utf8')) !== record.configHash) throw new Error('tally.yaml changed after init; preserve or remove it manually before uninstalling.');
  const configuredBin = existsSync(configPath) ? (parseYaml(readFileSync(configPath, 'utf8')) as { repo?: { aoBin?: unknown } } | null)?.repo?.aoBin : undefined;
  const aoBin = typeof configuredBin === 'string' ? configuredBin : undefined;
  const command = options.command ?? ((file, args, commandOptions) => defaultCommand(file, args, { ...commandOptions, aoBin: aoBin ? resolve(dirname(configPath), aoBin) : undefined }));
  const cwd = dirname(configPath);
  const direct = record.runner === 'direct';
  const current = direct ? {} : (JSON.parse((await command('ao', ['project', 'get', record.projectId, '--json'], { cwd })).stdout) as { project: { config?: Record<string, unknown> } }).project.config ?? {};
  if (direct && (record.projectCreated || record.addedSetupCommand || record.workerAfterHash)) throw new Error('Invalid direct installation record contains AO ownership; refusing to uninstall.');
  if (record.projectCreated && configHash(current) !== record.projectConfigHash) throw new Error('AO project configuration changed after init; refusing to unregister it.');
  if (!record.projectCreated && record.addedSetupCommand && configHash(current.postCreate ?? []) !== record.postCreateAfterHash) {
    throw new Error('AO post-create hooks changed after init; refusing to overwrite them.');
  }
  if (!record.projectCreated && record.workerAfterHash && configHash(current.worker) !== record.workerAfterHash) throw new Error('AO worker settings changed after init; refusing to overwrite them.');
  if (record.projectCreated) {
    const sessions = JSON.parse((await command('ao', ['session', 'ls', '--project', record.projectId, '--json'], { cwd })).stdout) as { sessions?: unknown[] } | unknown[];
    const active = Array.isArray(sessions) ? sessions : sessions.sessions;
    if (!Array.isArray(active) || active.length) throw new Error('AO project still has active sessions, or session status is unavailable; stop them before uninstalling.');
  }
  const items = [configPath, recordPath,
    ...(record.projectCreated ? [`AO project registration: ${record.projectId}`] : [
      ...(record.addedSetupCommand ? [`AO post-create hook: ${record.addedSetupCommand}`] : []),
      ...(record.workerAfterHash ? ['AO project worker permission mode (restore previous worker settings)'] : []),
    ])];
  for (const item of items) options.print?.(`Remove: ${item}`);
  if (!/^y(?:es)?$/i.test((await (options.readLine ?? defaultReadLine)('Remove the listed Tally installation items? y/N', 'N')).trim())) return { removed: false, items };
  if (record.projectCreated) {
    await command('ao', ['project', 'rm', record.projectId, '--yes', '--json'], { cwd });
  } else if (record.addedSetupCommand || record.workerAfterHash) {
    const next = { ...current };
    if (record.addedSetupCommand) {
      const kept = (current.postCreate as string[]).filter((hook) => hook !== record.addedSetupCommand);
      if (record.postCreateExisted) next.postCreate = kept;
      else delete next.postCreate;
    }
    if (record.workerAfterHash) {
      if (record.workerExisted) next.worker = record.workerBefore;
      else delete next.worker;
    }
    await command('ao', ['project', 'set-config', record.projectId, '--config-json', JSON.stringify(next), '--json'], { cwd });
  }
  if (existsSync(configPath)) unlinkSync(configPath);
  unlinkSync(recordPath);
  return { removed: true, items };
}
