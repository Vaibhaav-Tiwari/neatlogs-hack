import type { Tier } from '../schema/types.js';
import type { InitCommandRunner } from './init.js';

export type Harness = Tier['harness'];
export interface HarnessStatus { harness: Harness; installed: boolean; signedIn: boolean; detail: string; fix: string }

/** CLI-owned status only: never inspect credential files or invoke inference. */
export async function checkHarness(harness: Harness, command: InitCommandRunner, cwd?: string): Promise<HarnessStatus> {
  const file = harness === 'claude-code' ? 'claude' : 'codex';
  const fix = harness === 'claude-code' ? 'claude auth login' : 'codex login';
  try { await command(file, ['--version'], { cwd }); }
  catch { return { harness, installed: false, signedIn: false, detail: `${file} is not installed or cannot run; install it before using ${harness} tiers`, fix: `Install ${harness === 'claude-code' ? 'Claude Code (https://code.claude.com/docs/en/setup)' : 'Codex CLI (https://developers.openai.com/codex/cli/)'}; then ${fix}` }; }
  try {
    const output = await command(file, harness === 'claude-code' ? ['auth', 'status'] : ['login', 'status'], { cwd });
    const signedIn = harness === 'claude-code' ? JSON.parse(output.stdout).loggedIn === true
      : /\blogged in\b/i.test(`${output.stdout}\n${output.stderr}`) && !/\bnot logged in\b/i.test(`${output.stdout}\n${output.stderr}`);
    return { harness, installed: true, signedIn, detail: signedIn ? `${file} is installed and signed in (CLI status; model access not probed)` : `${file} is signed out or its sign-in status could not be verified`, fix };
  } catch { return { harness, installed: true, signedIn: false, detail: `${file} is signed out or its sign-in status could not be verified`, fix }; }
}

export function claudeAllowList(test: { command: string; setupCommand?: string }): string[] {
  const commands = ['git add *', 'git commit *', 'git status', 'git status *', 'git diff', 'git diff *', test.command, ...(test.setupCommand ? [test.setupCommand] : [])];
  if (commands.some(value => /[\r\n]/.test(value))) throw new Error('Claude allow-list needs single-line test and setup commands');
  return [...new Set(['Edit(./**)', 'Write(./**)', ...commands.map(value => `Bash(${value})`)])];
}
