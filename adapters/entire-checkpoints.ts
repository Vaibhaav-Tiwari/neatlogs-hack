import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckpointInfo, CheckpointPort, HandoffContext, HandoffPort, HandoffSummary } from '../agent/ports.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>;

export interface EntireCheckpointOptions {
  repoPath: string;
  command?: CommandRunner;
  summaryTimeoutSec?: number;
}

interface PendingCheckpoint {
  id?: unknown;
  checkpoint_id?: unknown;
  condensation_id?: unknown;
  session_id?: unknown;
  branch?: unknown;
  url?: unknown;
  web_url?: unknown;
  html_url?: unknown;
  date?: unknown;
}

interface SessionInfo {
  session_id?: unknown;
  branch?: unknown;
  last_checkpoint_id?: unknown;
  checkpoint_id?: unknown;
}

interface ExplainEnvelope {
  checkpoint_id?: unknown;
  branch?: unknown;
  url?: unknown;
  web_url?: unknown;
  html_url?: unknown;
}

function defaultCommand(file: string, args: string[], options?: { cwd?: string }): Promise<CommandResult> {
  return execFileAsync(file, args, { cwd: options?.cwd, maxBuffer: 10 * 1024 * 1024 });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function checkpointId(value: PendingCheckpoint | SessionInfo | ExplainEnvelope): string | null {
  return text(value.checkpoint_id) ?? text((value as PendingCheckpoint).condensation_id) ?? text((value as PendingCheckpoint).id);
}

function checkpointUrl(value: PendingCheckpoint | ExplainEnvelope): string | null {
  return text(value.url) ?? text(value.web_url) ?? text(value.html_url);
}

function latestForSession(checkpoints: PendingCheckpoint[], sessionId: string): PendingCheckpoint | null {
  return checkpoints
    .filter((candidate) => text(candidate.session_id) === sessionId && checkpointId(candidate))
    .sort((a, b) => String(text(b.date) ?? '').localeCompare(String(text(a.date) ?? '')))[0] ?? null;
}

function trailerFrom(message: string): string | null {
  return /^Entire-Checkpoint:\s*(\S+)/im.exec(message)?.[1] ?? null;
}

function trimSummary(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^Generating checkpoint summary|^→ |^✓ |^✗ /.test(line.trim()))
    .join('\n')
    .trim()
    .slice(0, 4000);
}

export class EntireCheckpointAdapter implements HandoffPort, CheckpointPort {
  private readonly command: CommandRunner;
  private readonly repoPath: string;
  private readonly summaryTimeoutSec: number;

  constructor(options: EntireCheckpointOptions) {
    this.command = options.command ?? defaultCommand;
    this.repoPath = options.repoPath;
    this.summaryTimeoutSec = options.summaryTimeoutSec ?? 45;
  }

  async checkpointFor(context: HandoffContext & { sessionId: string }): Promise<CheckpointInfo | null> {
    const found = await this.findCheckpoint(context);
    return found ? { checkpointId: found.checkpointId, checkpointUrl: found.checkpointUrl } : null;
  }

  async summaryFor(sessionId: string, context: HandoffContext = {}): Promise<HandoffSummary | null> {
    const found = await this.findCheckpoint({ ...context, sessionId });
    if (!found) return null;
    const generated = await this.command(
      'entire',
      ['checkpoint', 'explain', found.checkpointId, '--generate', '--summary-timeout-seconds', String(this.summaryTimeoutSec), '--no-pager'],
      { cwd: context.checkoutPath ?? this.repoPath },
    ).catch(() => null);
    const fallback = generated
      ? null
      : await this.command('entire', ['checkpoint', 'explain', found.checkpointId, '--short', '--no-pager'], { cwd: context.checkoutPath ?? this.repoPath }).catch(
          () => null,
        );
    const summary = trimSummary(`${generated?.stdout ?? fallback?.stdout ?? ''}\n${generated?.stderr ?? fallback?.stderr ?? ''}`);
    if (!summary) return null;
    return {
      type: 'entire-handoff',
      summary,
      branch: found.branch ?? context.branch ?? null,
      checkpointId: found.checkpointId,
      checkpointUrl: found.checkpointUrl,
      summaryCostNanos: 0,
      summaryCostSource: 'ao-estimate',
    };
  }

  private async findCheckpoint(context: HandoffContext & { sessionId: string }): Promise<(CheckpointInfo & { branch: string | null }) | null> {
    if (context.checkpointId) return this.explain(context.checkpointId, context);
    const session = await this.sessionInfo(context.sessionId, context.checkoutPath);
    const sessionCheckpoint = checkpointId(session ?? {});
    if (sessionCheckpoint) return this.explain(sessionCheckpoint, { ...context, branch: text(session?.branch) ?? context.branch ?? null });

    const pending = await this.checkpointList(['checkpoint', 'list', '--pending', '--json'], context.checkoutPath);
    const pendingMatch = latestForSession(pending, context.sessionId);
    if (pendingMatch) return this.explain(checkpointId(pendingMatch)!, { ...context, branch: text(pendingMatch.branch) ?? context.branch ?? null });

    const condensed = await this.checkpointList(['checkpoint', 'list', '--json', '--session', context.sessionId], context.checkoutPath);
    const condensedMatch = latestForSession(condensed, context.sessionId);
    if (condensedMatch) return this.explain(checkpointId(condensedMatch)!, { ...context, branch: text(condensedMatch.branch) ?? context.branch ?? null });

    if (context.checkoutPath) {
      const log = await this.command('git', ['log', '-1', '--format=%B'], { cwd: context.checkoutPath }).catch(() => null);
      const trailer = log ? trailerFrom(log.stdout) : null;
      if (trailer) return this.explain(trailer, context);
    }
    return null;
  }

  private async sessionInfo(sessionId: string, cwd?: string | null): Promise<SessionInfo | null> {
    const result = await this.command('entire', ['session', 'info', sessionId, '--json'], { cwd: cwd ?? this.repoPath }).catch(() => null);
    return result ? parseJson<SessionInfo>(result.stdout) : null;
  }

  private async checkpointList(args: string[], cwd?: string | null): Promise<PendingCheckpoint[]> {
    const result = await this.command('entire', args, { cwd: cwd ?? this.repoPath }).catch(() => null);
    return parseJson<PendingCheckpoint[]>(result?.stdout ?? '') ?? [];
  }

  private async explain(id: string, context: HandoffContext): Promise<(CheckpointInfo & { branch: string | null }) | null> {
    const result = await this.command('entire', ['checkpoint', 'explain', id, '--json', '--no-pager'], { cwd: context.checkoutPath ?? this.repoPath }).catch(
      () => null,
    );
    const parsed = result ? parseJson<ExplainEnvelope>(result.stdout) : null;
    const checkpoint = checkpointId(parsed ?? {}) ?? id;
    return {
      checkpointId: checkpoint,
      checkpointUrl: parsed ? checkpointUrl(parsed) : null,
      branch: text(parsed?.branch) ?? context.branch ?? null,
    };
  }
}
