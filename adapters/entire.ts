import { runCommand } from './command.js';
import { isAbsolute, relative, resolve } from 'node:path';
import { capImpact } from '../agent/impact.js';
import type { SizingSignals, SizingSignalsPort, TaskInput } from '../agent/ports.js';
import type { IntegrationState, TaskImpact } from '../schema/types.js';

const execFileAsync = runCommand;

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

function record(value: Json): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function entries(value: Json, group: string): Array<Record<string, Json>> {
  return objects(record(record(value)[group] ?? null).entries ?? []);
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
  private graphIndexPromise: Promise<void> | null = null;
  private graphStatus: IntegrationState = {
    status: 'missing',
    detail: 'Entire graph has not succeeded yet. Falling back to code search. Fix: run `entire enable` in this repository.',
  };

  constructor(options: EntireSizingOptions) {
    this.repoPath = options.repoPath;
    this.runner = options.runner ?? new ShellCommandRunner();
    this.topSymbols = options.topSymbols ?? 3;
  }

  async signalsFor(task: TaskInput): Promise<SizingSignals | null> {
    const query = `${task.title}\n${task.body}`.trim();
    if (query === '') return null;
    try {
      const signals = await this.entireGraphSignals(query);
      this.graphStatus = { status: 'ok', detail: null };
      return signals;
    } catch (e) {
      this.graphStatus = {
        status: 'missing',
        detail: `Entire graph is unavailable (${(e as Error).message}). Falling back to code search. Fix: run \`entire enable\` in this repository.`,
      };
      return this.codeSearchSignals(query);
    }
  }

  status(): IntegrationState {
    return this.graphStatus;
  }

  private async entireGraphSignals(query: string): Promise<SizingSignals> {
    this.graphIndexPromise ??= this.runner.run('entire', ['graph', 'index', '--repo', this.repoPath]).then(() => undefined).catch((error) => {
      this.graphIndexPromise = null;
      throw error;
    });
    await this.graphIndexPromise;
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
    const hits = objects(parseJson(search.stdout)).filter((hit) => hit.section !== 'related' &&
      (typeof hit.score !== 'number' || hit.score > 0) && stringField(hit, ['qualified_name', 'symbol', 'symbol_name', 'name']));
    const files = new Set<string>();
    const nodes = new Map<string, TaskImpact['nodes'][number]>();
    const edges = new Map<string, TaskImpact['edges'][number]>();
    let callers = 0;
    let coChanges = 0;
    let truncated = false;
    const addNode = (path: string | null, kind: TaskImpact['nodes'][number]['kind'], weight: number, symbol?: string): string | null => {
      const id = path ? this.repoRelative(path) : null;
      if (!id) return null;
      const previous = nodes.get(id);
      const priority = { target: 4, test: 3, caller: 2, coChange: 1 };
      const candidate = { id, kind, weight, ...(symbol ? { symbol } : {}) };
      if (!previous || priority[kind] > priority[previous.kind]) nodes.set(id, candidate);
      else if (weight > (previous.weight ?? 0)) nodes.set(id, { ...previous, weight });
      return id;
    };
    const addEdge = (from: string, to: string, kind: TaskImpact['edges'][number]['kind']) => {
      if (from !== to) edges.set(`${from}:${to}:${kind}`, { from, to, kind });
    };
    for (const [index, hit] of hits.entries()) {
      const hitFile = stringField(hit, ['file_path', 'file', 'path']);
      const symbol = stringField(hit, ['qualified_name', 'symbol', 'symbol_name', 'name'])!;
      const target = addNode(hitFile, hitFile && looksLikeTest(hitFile) ? 'test' : 'target', typeof hit.score === 'number' ? hit.score : 100, symbol);
      if (!target) { truncated = true; continue; }
      files.add(target);
      // Size uses the full primary search spread; expensive impact probes stay bounded.
      if (index >= this.topSymbols) { truncated = true; continue; }
      const impact = parseJson((await this.runner.run('entire', ['graph', 'impact', '--repo', this.repoPath, '--symbol', symbol, '--format', 'json'])).stdout);
      callers += countField(impact, 'callers');
      coChanges += countField(impact, 'co_changes');
      for (const group of ['callers', 'co_changes']) {
        const connected = entries(impact, group);
        if (connected.length < countField(impact, group)) truncated = true;
        for (const entry of connected) {
          const endpoint = record(entry.endpoint ?? entry);
          const path = stringField(endpoint, ['file_path', 'file', 'path']);
          const test = path !== null && looksLikeTest(path);
          if (group === 'callers' && entry.depth !== undefined && entry.depth !== 1 && !test) { truncated = true; continue; }
          const kind = test ? 'test' : group === 'callers' ? 'caller' : 'coChange';
          const weight = typeof entry.weight === 'number' ? entry.weight : group === 'callers' ? 10 : 1;
          const id = addNode(path, kind, weight, stringField(endpoint, ['qualified_name', 'name']) ?? undefined);
          if (!id) { truncated = true; continue; }
          if (test) addEdge(id, target, 'tests');
          else if (group === 'callers') addEdge(id, target, 'calls');
          else addEdge(target, id, 'changesWith');
        }
      }
    }
    if (!files.size) throw new Error('graph search returned no target symbols');
    const totals = { filesTouched: files.size, dependents: callers + coChanges, testsPresent: [...nodes.keys()].some(looksLikeTest), nodes: nodes.size, edges: edges.size };
    return {
      filesTouched: totals.filesTouched, dependents: totals.dependents, testsPresent: totals.testsPresent,
      source: 'entire-graph',
      impact: capImpact({ source: 'entire-graph', query, nodes: [...nodes.values()], edges: [...edges.values()], totals, truncated }),
    };
  }

  private repoRelative(path: string): string | null {
    const normalized = (isAbsolute(path) ? relative(resolve(this.repoPath), path) : path).replaceAll('\\', '/').replace(/^\.\//, '');
    return normalized && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') ? normalized : null;
  }

  private async codeSearchSignals(query: string): Promise<SizingSignals | null> {
    const terms = words(query);
    if (terms.length === 0) return null;
    const files = new Set<string>();
    for (const term of terms) {
      try {
        const result = await this.runner.run('rg', ['-l', '--fixed-strings', term, this.repoPath]);
        for (const file of result.stdout.split(/\r?\n/)) {
          const path = this.repoRelative(file.trim());
          if (path) files.add(path);
        }
      } catch {
        // Some terms will not match; keep trying the rest.
      }
    }
    if (files.size === 0) return null;
    const totals = { filesTouched: files.size, dependents: 0, testsPresent: [...files].some(looksLikeTest), nodes: files.size, edges: 0 };
    return {
      filesTouched: totals.filesTouched, dependents: totals.dependents, testsPresent: totals.testsPresent,
      source: 'code-search',
      impact: capImpact({ source: 'code-search', query, nodes: [...files].map((id) => ({ id, kind: 'target', weight: 1 })), edges: [], totals, truncated: false }),
    };
  }
}
