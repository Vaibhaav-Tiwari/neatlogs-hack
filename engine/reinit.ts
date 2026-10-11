import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { CommandError } from '../adapters/command.js';
import { contentHash, installRecordPath, type InstallRecord } from './install-record.js';

export interface ReinitPlan {
  version: 1;
  configPath: string;
  beforeConfig: string;
  afterConfig: string;
  beforeRecord: string | null;
  afterRecord: string | null;
}

export function reinitPath(configPath: string): string {
  return resolve(dirname(configPath), '.tally', 'reinit-pending.json');
}

export function readReinit(configPath: string): ReinitPlan | null {
  const path = reinitPath(configPath);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ReinitPlan;
    if (!value || value.version !== 1 || value.configPath !== configPath || typeof value.beforeConfig !== 'string' ||
        typeof value.afterConfig !== 'string' || (value.beforeRecord !== null && typeof value.beforeRecord !== 'string') ||
        (value.afterRecord !== null && typeof value.afterRecord !== 'string')) throw new Error('invalid');
    return value;
  } catch { throw new CommandError(`Invalid re-init recovery record at ${path}; preserve it and inspect it before retrying.`); }
}

export function prepareReinit(configPath: string, afterConfig: string): ReinitPlan {
  const path = installRecordPath(configPath);
  const beforeRecord = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let afterRecord: string | null = null;
  if (beforeRecord !== null) {
    const record = JSON.parse(beforeRecord) as InstallRecord;
    if (!record || record.version !== 1 || record.configPath !== configPath || typeof record.projectId !== 'string') {
      throw new CommandError(`Invalid installation ownership record at ${path}; no changes made.`);
    }
    afterRecord = JSON.stringify({ ...record, configHash: contentHash(afterConfig) }, null, 2);
  }
  return { version: 1, configPath, beforeConfig: readFileSync(configPath, 'utf8'), afterConfig, beforeRecord, afterRecord };
}

function checkFile(path: string, before: string | null, after: string | null): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current !== before && current !== after) throw new CommandError(`Re-init refused: ${path} changed since the proposal; preserve your edits before retrying.`);
}

function replaceFile(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function applyReinit(plan: ReinitPlan): void {
  const recordPath = installRecordPath(plan.configPath);
  const pendingPath = reinitPath(plan.configPath);
  checkFile(plan.configPath, plan.beforeConfig, plan.afterConfig);
  checkFile(recordPath, plan.beforeRecord, plan.afterRecord);
  try {
    mkdirSync(dirname(pendingPath), { recursive: true });
    if (!existsSync(pendingPath)) writeFileSync(pendingPath, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
    checkFile(plan.configPath, plan.beforeConfig, plan.afterConfig);
    replaceFile(plan.configPath, plan.afterConfig);
    if (plan.afterRecord !== null) {
      checkFile(recordPath, plan.beforeRecord, plan.afterRecord);
      replaceFile(recordPath, plan.afterRecord);
    }
  } catch (error) {
    const updated = existsSync(plan.configPath) && readFileSync(plan.configPath, 'utf8') === plan.afterConfig;
    throw new CommandError(`Re-init stopped: ${error instanceof Error ? error.message : 'write failed'}; configuration ${updated ? 'was updated' : 'was not updated'}; AO settings were not changed; ownership record ${existsSync(recordPath) ? 'exists' : 'was not written'}; rerun tally init --config ${JSON.stringify(plan.configPath)} to resume safely from ${pendingPath}.`);
  }
}

export function finishReinit(configPath: string): void {
  unlinkSync(reinitPath(configPath));
}
