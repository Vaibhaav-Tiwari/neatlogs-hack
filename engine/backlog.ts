import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AttemptResult, TaskSize, TallyConfig } from '../schema/index.js';

export interface BacklogTask {
  taskId: string;
  title: string;
  body: string;
  issueNumber: number | null;
  issueUrl: string | null;
  size: TaskSize;
  /** Scripted attempt outcomes for dry runs. Defaults to one passed attempt. */
  outcomes: AttemptResult[];
}

export class BacklogError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`${path}: ${problems.join('; ')}`);
    this.name = 'BacklogError';
  }
}

const SIZES = new Set<TaskSize>(['small', 'medium', 'large']);
const OUTCOMES = new Set<AttemptResult>(['passed', 'failed', 'stopped', 'error']);

function stringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberAt(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

function parseOutcomes(value: unknown, problems: string[], prefix: string): AttemptResult[] {
  if (value === undefined) return ['passed'];
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${prefix}.outcomes must be a non-empty array`);
    return ['error'];
  }
  return value.map((item, index) => {
    if (typeof item === 'string' && OUTCOMES.has(item as AttemptResult)) return item as AttemptResult;
    problems.push(`${prefix}.outcomes[${index}] must be passed, failed, stopped or error`);
    return 'error';
  });
}

function normaliseTask(value: unknown, index: number, problems: string[]): BacklogTask | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`/tasks/${index} must be an object`);
    return null;
  }
  const task = value as Record<string, unknown>;
  const taskId = stringAt(task, ['taskId', 'id']);
  const title = stringAt(task, ['title']);
  const size = task.size;
  const prefix = `/tasks/${taskId ?? index}`;
  if (taskId === undefined) problems.push(`${prefix}.taskId is required`);
  if (title === undefined) problems.push(`${prefix}.title is required`);
  if (typeof size !== 'string' || !SIZES.has(size as TaskSize)) {
    problems.push(`${prefix}.size must be small, medium or large`);
  }
  if (taskId === undefined || title === undefined || typeof size !== 'string' || !SIZES.has(size as TaskSize)) return null;
  return {
    taskId,
    title,
    body: stringAt(task, ['body', 'description']) ?? '',
    issueNumber: numberAt(task, ['issueNumber', 'number']),
    issueUrl: stringAt(task, ['issueUrl', 'url']) ?? null,
    size: size as TaskSize,
    outcomes: parseOutcomes(task.outcomes, problems, prefix),
  };
}

/** Reads the file fallback backlog. GitHub issue intake will plug in beside this adapter. */
export function loadFileBacklog(config: TallyConfig, configPath: string): BacklogTask[] {
  if (config.backlog.source !== 'file') {
    throw new BacklogError(configPath, ['github issue intake is not implemented yet; use backlog.source=file for dry runs']);
  }
  if (config.backlog.file === undefined) {
    throw new BacklogError(configPath, ['backlog.file is required when backlog.source=file']);
  }
  const path = resolve(dirname(configPath), config.backlog.file);
  if (!existsSync(path)) throw new BacklogError(path, ['file not found']);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new BacklogError(path, [`not valid YAML or JSON: ${(e as Error).message}`]);
  }
  const rawTasks =
    Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null ? (parsed as { tasks?: unknown }).tasks : undefined;
  if (!Array.isArray(rawTasks)) throw new BacklogError(path, ['expected an array or an object with a tasks array']);
  const problems: string[] = [];
  const tasks = rawTasks.map((item, i) => normaliseTask(item, i, problems)).filter((task): task is BacklogTask => task !== null);
  if (problems.length > 0) throw new BacklogError(path, problems);
  return tasks;
}
