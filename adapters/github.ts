import { CommandError, runCommand } from './command.js';
import type { TallyConfig } from '../schema/index.js';
import { type BacklogTask, loadFileBacklog } from '../engine/backlog.js';

const execFileAsync = runCommand;

export type GithubCommand = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface BacklogIntakePort {
  tasks(config: TallyConfig, configPath: string): Promise<BacklogTask[]>;
}

interface IssueJson {
  number: number;
  title: string;
  body?: string;
  url: string;
}

interface PullRequestJson {
  closingIssuesReferences: Array<{ url: string }>;
}

function quote(value: string): string {
  return /^[a-zA-Z0-9,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function githubDiagnostic(error: unknown): string {
  const detail = error instanceof CommandError ? error.stderr || error.message : error instanceof Error ? error.message : 'unknown error';
  return detail.replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+\b/g, '[redacted]')
    .replace(/\b(?:Authorization|token|password|api[-_ ]?key)\s*[:=][^\r\n]*/gi, '[credential redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

function defaultCommand(file: string, args: string[], options?: { cwd?: string }) {
  return execFileAsync(file, args, { cwd: options?.cwd });
}

function issueToTask(issue: IssueJson): BacklogTask {
  return {
    taskId: `#${issue.number}`,
    title: issue.title,
    body: issue.body ?? '',
    issueNumber: issue.number,
    issueUrl: issue.url,
    // Real sizing comes from lane B. This is only a placeholder until sizeTask runs.
    size: 'medium',
    outcomes: ['passed'],
  };
}

export class GithubIssueIntake implements BacklogIntakePort {
  constructor(private readonly command: GithubCommand = defaultCommand) {}

  private async read<T>(args: string[]): Promise<T> {
    try {
      const { stdout } = await this.command('gh', args);
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(`GitHub intake could not complete: ${githubDiagnostic(error)}. Check this read-only command: gh ${args.map(quote).join(' ')}`);
    }
  }

  async tasks(config: TallyConfig, _configPath: string): Promise<BacklogTask[]> {
    if (!config.repo.slug) throw new Error('repo.slug is required for github issue intake');
    if (!config.backlog.issueLabel) throw new Error('backlog.issueLabel is required for github issue intake');
    const issues = await this.read<IssueJson[]>([
      'issue',
      'list',
      '--repo',
      config.repo.slug,
      '--label',
      config.backlog.issueLabel,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,body,url',
    ]);
    if (issues.length === 0) return [];
    const pullRequests = await this.read<PullRequestJson[]>([
      'pr', 'list', '--repo', config.repo.slug, '--state', 'open', '--limit', '1000', '--json', 'closingIssuesReferences',
    ]);
    // Do not silently miss an existing PR if the bounded query is truncated.
    if (pullRequests.length >= 1000) throw new Error('GitHub intake reached the 1000 open-PR safety limit; narrow the repository backlog before running Tally. Nothing was started.');
    if (pullRequests.some(pr => !Array.isArray(pr.closingIssuesReferences))) throw new Error('GitHub intake could not read open PR closing-issue references; nothing was started.');
    const alreadyPublishing = new Set(pullRequests.flatMap(pr => pr.closingIssuesReferences.map(issue => issue.url.toLowerCase())));
    return issues.filter(issue => !alreadyPublishing.has(issue.url.toLowerCase())).map(issueToTask);
  }
}

export class ConfigBacklogIntake implements BacklogIntakePort {
  constructor(private readonly github = new GithubIssueIntake()) {}

  async tasks(config: TallyConfig, configPath: string): Promise<BacklogTask[]> {
    if (config.backlog.source === 'file') return loadFileBacklog(config, configPath);
    return this.github.tasks(config, configPath);
  }
}
