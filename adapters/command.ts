import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class CommandError extends Error {
  constructor(message: string, readonly code?: string | number, readonly stdout = '', readonly stderr = '') { super(message); }
}

export interface AoBinaryOptions {
  aoBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
  bundleRoots?: string[];
}

export function resolveAoBinary(options: AoBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const candidates = (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => resolve(cwd, dir, 'ao'));
  for (const override of [env.TALLY_AO_BIN, options.aoBin]) if (override) candidates.push(resolve(cwd, override));
  if ((options.platform ?? process.platform) === 'darwin') {
    const suffix = 'Agent Orchestrator.app/Contents/Resources/daemon/ao';
    candidates.push(...(options.bundleRoots ?? ['/Applications', join(options.home ?? homedir(), 'Applications')]).map((root) => join(root, suffix)));
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next explicit location. */ }
  }
  throw new CommandError(`Agent Orchestrator (AO) is required; looked in PATH (${env.PATH || 'empty'}), TALLY_AO_BIN (${env.TALLY_AO_BIN || 'unset'}), repo.aoBin (${options.aoBin || 'unset'}) and ${candidates.filter((path) => path.includes('.app/')).join(', ') || 'no app-bundle locations on this platform'}; install AO or set TALLY_AO_BIN to its executable path.`, 'ENOENT');
}

/** Resolve Entire's standard user-local install location even when the shell PATH omits it. */
export function resolveEntireBinary(options: Pick<AoBinaryOptions, 'platform' | 'home'> = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const local = join(home, '.local', 'bin', platform === 'win32' ? 'entire.exe' : 'entire');
  try {
    accessSync(local, platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (statSync(local).isFile()) return local;
  } catch { /* Fall back to the user's PATH. */ }
  return 'entire';
}

export async function runCommand(file: string, args: string[], options: AoBinaryOptions & { timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  const executable = file === 'ao' ? resolveAoBinary(options) : file === 'entire' ? resolveEntireBinary(options) : file;
  try {
    return await execFileAsync(executable, args, { cwd: options.cwd, env: options.env, timeout: options.timeout, maxBuffer: options.maxBuffer, encoding: 'utf8' });
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: unknown; stderr?: unknown };
    const code = failure.code;
    throw new CommandError(code === 'ENOENT'
      ? `${file} is required but could not be started; install it or add its executable to PATH${options.cwd ? `, and check that ${options.cwd} exists` : ''}.`
      : `${file} command failed (${code ?? 'unknown error'}); check the command in your terminal before retrying.`, code,
      typeof failure.stdout === 'string' ? failure.stdout : '', typeof failure.stderr === 'string' ? failure.stderr : '');
  }
}
