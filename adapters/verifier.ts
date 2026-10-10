import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TallyConfig } from '../schema/index.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
