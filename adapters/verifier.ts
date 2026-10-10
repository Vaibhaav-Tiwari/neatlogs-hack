import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { TallyConfig } from '../schema/index.js';

const execAsync = promisify(exec);

export interface VerifyInput {
  checkoutPath: string | null;
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

function defaultRunner(command: string, options: { cwd: string; timeout?: number }) {
  return execAsync(command, { cwd: options.cwd, timeout: options.timeout });
}

export class CommandVerifier implements VerifierPort {
  constructor(private readonly run: ShellRunner = defaultRunner) {}

  async verify(input: VerifyInput): Promise<VerifyResult> {
    if (!input.checkoutPath) return { passed: false, reason: 'worker checkout path was not reported' };
    try {
      if (input.config.test.setupCommand) {
        await this.run(input.config.test.setupCommand, {
          cwd: input.checkoutPath,
          timeout: (input.config.test.timeoutSec ?? 900) * 1000,
        });
      }
      await this.run(input.config.test.command, { cwd: input.checkoutPath, timeout: (input.config.test.timeoutSec ?? 900) * 1000 });
      return { passed: true, reason: null };
    } catch (e) {
      const error = e as { code?: unknown; signal?: unknown; stderr?: unknown; message?: string };
      const detail = typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr.trim().split('\n').slice(-3).join('\n') : error.message;
      return { passed: false, reason: `tests failed${error.code ? ` (${String(error.code)})` : ''}${detail ? `: ${detail}` : ''}` };
    }
  }
}
