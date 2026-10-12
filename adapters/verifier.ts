import { exec } from 'node:child_process';
import { runCommand } from './command.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TallyConfig } from '../schema/index.js';

const execAsync = promisify(exec);
const execFileAsync = runCommand;

export interface VerifyInput {
  checkoutPath: string | null;
  branch?: string | null;
  repoPath?: string;
  config: TallyConfig;
}

export interface VerifyResult {
  passed: boolean;
  reason: string | null;
}

export interface VerifierPort {
  verify(input: VerifyInput): Promise<VerifyResult>;
}

export type ShellRunner = (command: string, options: { cwd: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
export type WorktreeResolver = (repoPath: string, branch: string) => Promise<string | null>;
export type EntireVerifyRunner = (args: string[], options: { cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;

function defaultRunner(command: string, options: { cwd: string; timeout?: number }) {
  return execAsync(command, { cwd: options.cwd, timeout: options.timeout });
}

async function defaultWorktreeResolver(repoPath: string, branch: string): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
  let path: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

async function defaultEntireRunner(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('entire', args, { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const error = e as { stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
      code: typeof error.code === 'number' ? error.code : 1,
    };
  }
}

export class CommandVerifier implements VerifierPort {
  constructor(
    private readonly run: ShellRunner = defaultRunner,
    private readonly resolveWorktree: WorktreeResolver = defaultWorktreeResolver,
  ) {}

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const checkoutPath =
      input.checkoutPath ?? (input.branch && input.repoPath ? await this.resolveWorktree(input.repoPath, input.branch) : null);
    if (!checkoutPath) return { passed: false, reason: 'worker checkout path was not reported and branch worktree was not found' };
    try {
      if (input.config.test.setupCommand) {
        await this.run(input.config.test.setupCommand, {
          cwd: checkoutPath,
          timeout: (input.config.test.timeoutSec ?? 900) * 1000,
        });
      }
      await this.run(input.config.test.command, { cwd: checkoutPath, timeout: (input.config.test.timeoutSec ?? 900) * 1000 });
      return { passed: true, reason: null };
    } catch (e) {
      const error = e as { code?: unknown; signal?: unknown; stderr?: unknown; message?: string };
      const detail = typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr.trim().split('\n').slice(-3).join('\n') : error.message;
      return { passed: false, reason: `tests failed${error.code ? ` (${String(error.code)})` : ''}${detail ? `: ${detail}` : ''}` };
    }
  }
}

function listFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).slice(0, 20);
  if (typeof value === 'number') return value > 0 ? [`${value} tests`] : [];
  if (typeof value === 'string' && value.trim() !== '' && value.trim() !== '0') return [value.trim()];
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const ids = record.ids ?? record.tests ?? record.test_ids ?? record.count;
    return listFrom(ids);
  }
  return [];
}

function jsonVerdict(text: string): { newlyFailing: string[]; newlyPassing: string[]; preExisting: string[] } | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      newlyFailing: listFrom(parsed.newly_failing ?? parsed.newlyFailing ?? parsed.new_failures),
      newlyPassing: listFrom(parsed.newly_passing ?? parsed.newlyPassing ?? parsed.new_passes),
      preExisting: listFrom(parsed.pre_existing ?? parsed.preExisting ?? parsed.pre_existing_failures),
    };
  } catch {
    return null;
  }
}

function lineList(text: string, label: RegExp): string[] {
  const line = text.split(/\r?\n/).find((candidate) => label.test(candidate));
  if (!line) return [];
  if (/\b0\b|none/i.test(line) && !/:\s*[^0\s]/.test(line)) return [];
  const after = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
  return after
    .split(/,\s*|\s{2,}|;\s*/)
    .map((item) => item.replace(label, '').trim())
    .filter((item) => item !== '' && !/^0$|^none$/i.test(item))
    .slice(0, 20);
}

export function parseEntireVerifyVerdict(output: string, code: number): VerifyResult {
  const structured = jsonVerdict(output);
  const newlyFailing = structured?.newlyFailing ?? lineList(output, /newly[-_\s]+fail(?:ing|ed)?/i);
  const newlyPassing = structured?.newlyPassing ?? lineList(output, /newly[-_\s]+pass(?:ing|ed)?/i);
  const preExisting = structured?.preExisting ?? lineList(output, /pre[-_\s]+existing/i);
  const notes = [
    newlyPassing.length > 0 ? `newly passing tests: ${newlyPassing.join(', ')}` : null,
    preExisting.length > 0 ? `pre-existing failing tests: ${preExisting.join(', ')}` : null,
  ].filter((note): note is string => note !== null);
  if (newlyFailing.length > 0) {
    return {
      passed: false,
      reason: `newly failing tests: ${newlyFailing.join(', ')}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`,
    };
  }
  if (code === 0 || notes.length > 0) return { passed: true, reason: notes.length > 0 ? notes.join('; ') : null };
  const detail = output.trim().split(/\r?\n/).slice(-3).join('\n');
  return { passed: false, reason: `tests failed${detail ? `: ${detail}` : ''}` };
}

export class EntireGraphVerifier implements VerifierPort {
  constructor(
    private readonly fallback = new CommandVerifier(),
    private readonly runEntire: EntireVerifyRunner = defaultEntireRunner,
    private readonly resolveWorktree: WorktreeResolver = defaultWorktreeResolver,
  ) {}

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const checkoutPath =
      input.checkoutPath ?? (input.branch && input.repoPath ? await this.resolveWorktree(input.repoPath, input.branch) : null);
    if (!checkoutPath) return { passed: false, reason: 'worker checkout path was not reported and branch worktree was not found' };
    const baseline = join(mkdtempSync(join(tmpdir(), 'tally-entire-verify-')), 'baseline.json');
    const setup = input.config.test.setupCommand ? ['--setup', input.config.test.setupCommand] : [];
    const maxBytes = ['--max-bytes', '2048'];
    if (input.repoPath) {
      const recorded = await this.runEntire(
        ['graph', 'verify', '--repo', input.repoPath, '--test', input.config.test.command, ...setup, '--record-baseline', baseline, ...maxBytes],
        { cwd: input.repoPath },
      );
      if (recorded.code !== 0 && /unknown command|not found|No such file|not installed/i.test(`${recorded.stderr}\n${recorded.stdout}`)) {
        return this.fallback.verify(input);
      }
      const verified = await this.runEntire(
        ['graph', 'verify', '--repo', checkoutPath, '--test', input.config.test.command, ...setup, '--pre-edit-baseline', baseline, ...maxBytes],
        { cwd: checkoutPath },
      );
      const verdict = parseEntireVerifyVerdict(`${verified.stdout}\n${verified.stderr}`, verified.code);
      return recorded.code === 0
        ? verdict
        : {
            ...verdict,
            reason: [
              `Entire baseline recording command exited with code ${recorded.code}; inspect the test command on the base checkout.`,
              verdict.reason,
            ].filter((reason): reason is string => Boolean(reason)).join(' '),
          };
    }
    const verified = await this.runEntire(['graph', 'verify', '--repo', checkoutPath, '--test', input.config.test.command, ...setup, ...maxBytes], {
      cwd: checkoutPath,
    });
    if (verified.code !== 0 && /unknown command|not found|No such file|not installed/i.test(`${verified.stderr}\n${verified.stdout}`)) {
      return this.fallback.verify(input);
    }
    return parseEntireVerifyVerdict(`${verified.stdout}\n${verified.stderr}`, verified.code);
  }
}
