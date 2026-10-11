import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { AoHarnessPermissionModes } from './harness.js';

export interface InstallRecord {
  version: 1;
  runner?: 'ao' | 'direct';
  configPath: string;
  configHash: string;
  projectId: string;
  projectCreated: boolean;
  projectConfigHash: string;
  postCreateExisted: boolean;
  postCreateAfterHash: string;
  addedSetupCommand: string | null;
  workerExisted?: boolean;
  workerBefore?: unknown;
  workerAfterHash?: string;
  workerPermissionMode?: 'auto' | 'default';
  aoHarnessPermissions?: AoHarnessPermissionModes;
}

export function installRecordPath(configPath: string): string {
  return resolve(dirname(configPath), '.tally', 'install.json');
}

export function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function configHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : item;
  return contentHash(JSON.stringify(canonical(value)));
}
