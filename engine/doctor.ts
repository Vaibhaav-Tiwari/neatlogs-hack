import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEnv } from './env.js';

const execFileAsync = promisify(execFile);

export type DoctorStatus = 'connected' | 'missing' | 'broken';

export interface DoctorLine {
  product: string;
  status: DoctorStatus;
  detail: string;
  fix: string | null;
}

export type DoctorRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface DoctorOptions {
  runner?: DoctorRunner;
  env?: Record<string, string>;
}

function defaultRunner(file: string, args: string[]) {
  return execFileAsync(file, args);
}

async function commandLine(product: string, runner: DoctorRunner, file: string, args: string[], fix: string): Promise<DoctorLine> {
  try {
    await runner(file, args);
    return { product, status: 'connected', detail: 'ok', fix: null };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const status: DoctorStatus = code === 'ENOENT' ? 'missing' : 'broken';
    return { product, status, detail: status === 'missing' ? `${file} not found` : `${file} failed`, fix };
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorLine[]> {
  const runner = options.runner ?? defaultRunner;
  const env = options.env ?? loadEnv();
  const lines: DoctorLine[] = [];
  lines.push(await commandLine('AO daemon', runner, 'ao', ['status'], 'ao start'));
  lines.push(await commandLine('GitHub CLI', runner, 'gh', ['auth', 'status'], 'gh auth login'));
  lines.push(await commandLine('Entire CLI', runner, 'entire', ['--version'], 'pipx install entire'));
  lines.push(await commandLine('Entire graph plugin', runner, 'entire', ['graph', '--help'], 'entire enable'));
  lines.push(
    env.NEATLOGS_API_KEY
      ? { product: 'neatlogs key', status: 'connected', detail: 'NEATLOGS_API_KEY is set', fix: null }
      : {
          product: 'neatlogs key',
          status: 'missing',
          detail: 'NEATLOGS_API_KEY is missing from ~/.tally/.env',
          fix: "mkdir -p ~/.tally && printf 'NEATLOGS_API_KEY=...\\n' >> ~/.tally/.env",
        },
  );
  try {
    const { stdout } = await runner('claude', ['mcp', 'list']);
    const connected = /\bcfoai\b/i.test(stdout);
    lines.push(
      connected
        ? { product: 'cfo.ai', status: 'connected', detail: 'cfoai MCP is listed', fix: null }
        : {
            product: 'cfo.ai',
            status: 'missing',
            detail: 'cfoai MCP is not listed',
            fix: 'claude mcp add --scope user --transport http cfoai https://api.cfo.ai/mcp',
          },
    );
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    lines.push({
      product: 'cfo.ai',
      status: code === 'ENOENT' ? 'missing' : 'broken',
      detail: code === 'ENOENT' ? 'claude not found' : 'claude mcp list failed',
      fix: 'claude mcp add --scope user --transport http cfoai https://api.cfo.ai/mcp',
    });
  }
  return lines;
}
