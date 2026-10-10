import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BacklogTask } from '../engine/backlog.js';
import type { TallyConfig } from '../schema/index.js';

const execFileAsync = promisify(execFile);

export type PublishCommand = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface WorkerBranchInput {
  checkoutPath: string;
  branch: string;
  config: TallyConfig;
}

export interface PublishPrInput extends WorkerBranchInput {
  task: BacklogTask;
  runId: string;
  attempt: number;
}

export interface PublishPort {
  commitsAhead(input: WorkerBranchInput): Promise<number>;
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
  return [`Tally run ${input.runId}, task ${input.task.taskId}, attempt ${input.attempt}.`, '', input.task.body || '(No issue body was provided.)', issue].join('\n');
}

export class GitHubPublisher implements PublishPort {
  constructor(private readonly command: PublishCommand = defaultCommand) {}

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
}
