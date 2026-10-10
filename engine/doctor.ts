import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkCfoaiConnection } from '../adapters/cfoai.js';
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
  cfoaiCheck?: typeof checkCfoaiConnection;
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
  const cfoaiCheck = options.cfoaiCheck ?? checkCfoaiConnection;
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
  const cfoai = await cfoaiCheck();
  lines.push({
    product: 'cfo.ai',
    status: cfoai.status === 'ok' ? 'connected' : 'missing',
    detail: cfoai.detail ?? (cfoai.status === 'ok' ? 'Tally cached token works' : 'Tally cfo.ai token is missing or unusable'),
    fix: cfoai.status === 'ok' ? null : 'tally login cfoai',
  });
  return lines;
}
