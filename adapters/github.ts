import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TallyConfig } from '../schema/index.js';
import { type BacklogTask, loadFileBacklog } from '../engine/backlog.js';

const execFileAsync = promisify(execFile);

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

  async tasks(config: TallyConfig, _configPath: string): Promise<BacklogTask[]> {
    if (!config.repo.slug) throw new Error('repo.slug is required for github issue intake');
    if (!config.backlog.issueLabel) throw new Error('backlog.issueLabel is required for github issue intake');
    const { stdout } = await this.command('gh', [
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
    return (JSON.parse(stdout) as IssueJson[]).map(issueToTask);
  }
}

export class ConfigBacklogIntake implements BacklogIntakePort {
  constructor(private readonly github = new GithubIssueIntake()) {}

  async tasks(config: TallyConfig, configPath: string): Promise<BacklogTask[]> {
    if (config.backlog.source === 'file') return loadFileBacklog(config, configPath);
    return this.github.tasks(config, configPath);
  }
}
