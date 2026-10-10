import { runCommand } from './command.js';
import type { BacklogTask } from '../engine/backlog.js';
import type { TallyConfig } from '../schema/index.js';

const execFileAsync = runCommand;

export type PublishCommand = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface WorkerBranchInput {
  checkoutPath: string;
  branch: string;
  config: TallyConfig;
  baseCommit?: string | null;
}

export interface PublishPrInput extends WorkerBranchInput {
  task: BacklogTask;
  runId: string;
  attempt: number;
  scopeWarnings?: string[];
}

export interface PublishPort {
  commitsAhead(input: WorkerBranchInput): Promise<number>;
  changedFiles(input: WorkerBranchInput): Promise<string[]>;
  publishPr(input: PublishPrInput): Promise<string>;
}

function defaultCommand(file: string, args: string[], options?: { cwd?: string }) {
  return execFileAsync(file, args, { cwd: options?.cwd });
}

function errorMessage(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown };
  return typeof e.stderr === 'string' && e.stderr.trim() ? e.stderr.trim() : typeof e.message === 'string' ? e.message : String(error);
}

function prBody(input: PublishPrInput): string {
  const issue = input.task.issueNumber ? `\n\nRefs #${input.task.issueNumber}` : '';
  const warning = input.scopeWarnings?.length ? `\n\nScope warning: out-of-scope changes: ${input.scopeWarnings.join(', ')}` : '';
  return [`Tally run ${input.runId}, task ${input.task.taskId}, attempt ${input.attempt}.`, '', input.task.body || '(No issue body was provided.)', issue, warning].filter((part, index) => index < 4 || part).join('\n');
}

export class GitHubPublisher implements PublishPort {
  constructor(private readonly command: PublishCommand = defaultCommand) {}

  async changedFiles(input: WorkerBranchInput): Promise<string[]> {
    const base = input.baseCommit ?? `origin/${input.config.repo.baseBranch}`;
    const { stdout } = await this.command('git', ['diff', '--name-only', '-z', '--end-of-options', base, input.branch, '--'], { cwd: input.checkoutPath });
    return stdout.split('\0').filter(Boolean);
  }

  async commitsAhead(input: WorkerBranchInput): Promise<number> {
    try {
      const { stdout } = await this.command('git', ['rev-list', '--count', `origin/${input.config.repo.baseBranch}..HEAD`], { cwd: input.checkoutPath });
      return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      const { stdout } = await this.command('git', ['rev-list', '--count', `${input.config.repo.baseBranch}..HEAD`], { cwd: input.checkoutPath });
      return Number.parseInt(stdout.trim(), 10) || 0;
    }
  }

  async publishPr(input: PublishPrInput): Promise<string> {
    if (!input.config.repo.slug) throw new Error('repo.slug is required to open a GitHub pull request');
    await this.command('git', ['push', '-u', 'origin', `HEAD:${input.branch}`], { cwd: input.checkoutPath });
    if (input.config.integrations.entire) await this.pushCheckpoints(input);
    try {
      const { stdout } = await this.command(
        'gh',
        [
          'pr',
          'create',
          '--repo',
          input.config.repo.slug,
          '--head',
          input.branch,
          '--base',
          input.config.repo.baseBranch,
          '--title',
          `${input.task.taskId}: ${input.task.title}`,
          '--body',
          prBody(input),
        ],
        { cwd: input.checkoutPath },
      );
      return stdout.trim();
    } catch (error) {
      const message = errorMessage(error);
      if (!/already exists/i.test(message)) throw error;
      const { stdout } = await this.command('gh', ['pr', 'view', '--repo', input.config.repo.slug, '--head', input.branch, '--json', 'url', '-q', '.url'], {
        cwd: input.checkoutPath,
      });
      return stdout.trim();
    }
  }

  private async pushCheckpoints(input: PublishPrInput): Promise<void> {
    const options = { cwd: input.checkoutPath };
    const { stdout: messages } = await this.command('git', [
      'log', '--format=%B', '--end-of-options', `origin/${input.config.repo.baseBranch}..${input.branch}`, '--',
    ], options);
    const ids = new Set(Array.from(messages.matchAll(/^Entire-Checkpoint:\s*([A-Za-z0-9]+)\s*$/gm), (match) => match[1]!));
    if (!ids.size) return;
    const { stdout: refsOutput } = await this.command('git', ['for-each-ref', '--format=%(refname)', 'refs/entire/checkpoints/'], options);
    const refs = refsOutput.trim().split(/\r?\n/).filter((ref) => ids.has(ref.split('/').at(-1)!));
    for (const id of ids) {
      if (!refs.some((ref) => ref.endsWith(`/${id}`))) throw new Error(`Entire checkpoint ref missing for ${id}`);
    }
    const { stdout: remotes } = await this.command('git', ['remote'], options);
    for (const remote of ['origin', ...(remotes.split(/\r?\n/).includes('entire') ? ['entire'] : [])]) {
      await this.command('git', ['push', remote, ...refs.map((ref) => `${ref}:${ref}`)], options);
    }
  }
}
