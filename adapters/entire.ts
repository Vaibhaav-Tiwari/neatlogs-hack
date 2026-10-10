import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SizingSignals, SizingSignalsPort, TaskInput } from '../agent/ports.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string }): Promise<CommandResult>;
}

export interface EntireSizingOptions {
  repoPath: string;
  runner?: CommandRunner;
  topSymbols?: number;
}

export class ShellCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
    const { stdout } = await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout };
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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
  for (const key of ['results', 'matches', 'symbols']) {
    const list = value[key];
    if (Array.isArray(list)) return objects(list);
  }
  return [value];
}

function stringField(value: Record<string, Json>, names: string[]): string | null {
  for (const name of names) {
    const found = value[name];
    if (typeof found === 'string' && found.trim() !== '') return found;
  }
  return null;
}

function countField(value: Json, name: string): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0;
  const direct = value[name];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
    const total = direct.total;
    if (typeof total === 'number' && Number.isFinite(total)) return total;
  }
  return 0;
}

function collectFiles(value: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, out);
    return out;
  }
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(file|file_path|path)$/.test(key) && typeof nested === 'string' && nested.trim() !== '') out.add(nested);
    else collectFiles(nested, out);
  }
  return out;
}

function looksLikeTest(path: string): boolean {
  return /(^|[/\\])(__tests__|tests?|spec)([/\\])|[._-](test|spec)\.[cm]?[jt]sx?$|test_.*\.py$/i.test(path);
}

function words(text: string): string[] {
  const explicit = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).filter(Boolean);
  const plain = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? [];
  return [...new Set([...explicit, ...plain].map((word) => word.replace(/[^\w./-]/g, '')).filter((word) => word.length >= 4))].slice(0, 8);
}

export class EntireSizingAdapter implements SizingSignalsPort {
  private readonly repoPath: string;
  private readonly runner: CommandRunner;
  private readonly topSymbols: number;

  constructor(options: EntireSizingOptions) {
    this.repoPath = options.repoPath;
    this.runner = options.runner ?? new ShellCommandRunner();
    this.topSymbols = options.topSymbols ?? 3;
  }

  async signalsFor(task: TaskInput): Promise<SizingSignals | null> {
    const query = `${task.title}\n${task.body}`.trim();
    if (query === '') return null;
    try {
      return await this.entireGraphSignals(query);
    } catch {
      return this.codeSearchSignals(query);
    }
  }

  private async entireGraphSignals(query: string): Promise<SizingSignals> {
    await this.runner.run('entire', ['graph', 'index', '--repo', this.repoPath]);
    const search = await this.runner.run('entire', [
      'graph',
      'search',
      '--repo',
      this.repoPath,
      '--profile',
      'full',
      '--format',
      'json',
      '--query',
      query,
    ]);
    const hits = objects(parseJson(search.stdout)).slice(0, this.topSymbols);
    const files = new Set<string>();
    let callers = 0;
    let coChanges = 0;
    for (const hit of hits) {
      const hitFile = stringField(hit, ['file_path', 'file', 'path']);
      if (hitFile) files.add(hitFile);
      const symbol = stringField(hit, ['symbol', 'qualified_name', 'name']);
      if (!symbol) continue;
      const impact = parseJson((await this.runner.run('entire', ['graph', 'impact', '--repo', this.repoPath, '--symbol', symbol, '--format', 'json'])).stdout);
      for (const file of collectFiles(impact)) files.add(file);
      callers += countField(impact, 'callers');
      coChanges += countField(impact, 'co_changes');
    }
    return {
      filesTouched: Math.max(1, files.size || hits.length),
      dependents: callers + coChanges,
      testsPresent: [...files].some(looksLikeTest),
      source: 'entire-graph',
    };
  }

  private async codeSearchSignals(query: string): Promise<SizingSignals | null> {
    const terms = words(query);
    if (terms.length === 0) return null;
    const files = new Set<string>();
    for (const term of terms) {
      try {
        const result = await this.runner.run('rg', ['-l', '--fixed-strings', term, this.repoPath]);
        for (const file of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) files.add(file);
      } catch {
        // Some terms will not match; keep trying the rest.
      }
    }
    if (files.size === 0) return null;
    return {
      filesTouched: files.size,
      dependents: 0,
      testsPresent: [...files].some(looksLikeTest),
      source: 'code-search',
    };
  }
}
