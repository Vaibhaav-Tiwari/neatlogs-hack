import { runCommand } from './command.js';
import type { CheckpointRecall, CheckpointRecallPort, TaskInput } from '../agent/ports.js';
import type { IntegrationState } from '../schema/types.js';

const execFileAsync = runCommand;

export interface CommandResult {
  stdout: string;
}

export type CommandRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>;

export interface EntireRecallOptions {
  repoPath: string;
  command?: CommandRunner;
  limit?: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function defaultCommand(file: string, args: string[], options?: { cwd?: string }): Promise<CommandResult> {
  return execFileAsync(file, args, { cwd: options?.cwd, maxBuffer: 10 * 1024 * 1024 });
}

function parseJson(stdout: string): Json {
  try {
    return JSON.parse(stdout) as Json;
  } catch {
    return null;
  }
}

function objects(value: Json): Array<Record<string, Json>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, Json> => typeof item === 'object' && item !== null && !Array.isArray(item));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  for (const key of ['results', 'matches', 'checkpoints']) {
    const list = value[key];
    if (Array.isArray(list)) return objects(list);
  }
  return [value];
}

function stringField(value: Record<string, Json>, names: string[]): string | null {
  for (const name of names) {
    const found = value[name];
    if (typeof found === 'string' && found.trim() !== '') return found.trim();
  }
  return null;
}

function collectFiles(value: Json, out = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, out);
    return [...out];
  }
  if (typeof value !== 'object' || value === null) return [...out];
  for (const [key, nested] of Object.entries(value)) {
    if (/^(file|file_path|path)$/.test(key) && typeof nested === 'string' && nested.trim() !== '') out.add(nested.trim());
    else if (/files/i.test(key) && Array.isArray(nested)) {
      for (const item of nested) if (typeof item === 'string' && item.trim() !== '') out.add(item.trim());
      collectFiles(nested, out);
    } else if (/files/i.test(key)) collectFiles(nested, out);
  }
  return [...out];
}

function issueFiles(task: TaskInput): string[] {
  const text = `${task.title}\n${task.body}`;
  const explicit = [...text.matchAll(/`([^`]+\.[A-Za-z0-9]+)`/g)].map((match) => match[1]!);
  const bare = text.match(/\b[\w./-]+\.[A-Za-z0-9]{1,8}\b/g) ?? [];
  return [...new Set([...explicit, ...bare].map((file) => file.replace(/^[./]+/, '')).filter((file) => file.includes('.')))].slice(0, 6);
}

function sameFile(files: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return false;
  return files.some((file) => wanted.some((target) => file === target || file.endsWith(`/${target}`) || target.endsWith(`/${file}`)));
}

function failed(text: string): boolean {
  return /\b(failed|failing|failure|red|stopped|errored|error|regression|did not pass)\b/i.test(text);
}

export class EntireCheckpointRecallAdapter implements CheckpointRecallPort {
  private readonly command: CommandRunner;
  private readonly repoPath: string;
  private readonly limit: number;
  private availability: IntegrationState = { status: 'missing', detail: 'checkpoint recall has not been checked' };

  constructor(options: EntireRecallOptions) {
    this.command = options.command ?? defaultCommand;
    this.repoPath = options.repoPath;
    this.limit = options.limit ?? 5;
  }

  status(): IntegrationState { return this.availability; }

  async checkAvailability(): Promise<IntegrationState> {
    await this.search('Tally checkpoint recall availability');
    return this.status();
  }

  private async search(query: string): Promise<Json> {
    try {
      const result = await this.command('entire', ['checkpoint', 'search', query, '--json', '--compact', '--limit', String(this.limit)], { cwd: this.repoPath });
      const parsed = parseJson(result.stdout);
      if (parsed === null) throw new Error('checkpoint search returned invalid JSON');
      this.availability = { status: 'ok', detail: 'checkpoint search available' };
      return parsed;
    } catch (error) {
      const failure = error as { message?: string; stderr?: string };
      const reason = failure.stderr?.trim() || failure.message || 'checkpoint search failed';
      this.availability = { status: 'missing', detail: `checkpoint recall unavailable: ${reason}${/no matching repositories|mirrored/i.test(reason) ? '; repository is not mirrored to Entire or not accessible in the current account' : ''}` };
      return null;
    }
  }

  async recallFor(task: TaskInput): Promise<CheckpointRecall | null> {
    const files = issueFiles(task);
    if (files.length === 0) {
      if (this.availability.status !== 'missing' || this.availability.detail === 'checkpoint recall has not been checked') {
        this.availability = { status: 'ok', detail: 'checkpoint recall not used: issue has no explicit file references' };
      }
      return null;
    }
    const query = files.join(' ');
    const matches = objects(await this.search(query));
    for (const match of matches) {
      const touched = collectFiles(match);
      if (!sameFile(touched, files)) continue;
      const summary = stringField(match, ['match', 'snippet', 'title', 'summary']) ?? `checkpoint matched ${files[0]}`;
      const haystack = `${summary}\n${JSON.stringify(match)}`;
      if (!failed(haystack)) continue;
      return {
        checkpointId: stringField(match, ['checkpoint_id', 'checkpointId', 'id']) ?? 'unknown',
        checkpointUrl: stringField(match, ['url', 'web_url', 'html_url']),
        summary,
        files: touched.length > 0 ? touched : files,
        failed: true,
      };
    }
    return null;
  }
}
