import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WriteStream } from 'node:tty';

export type LogoTarget = 'bare' | 'help' | 'init' | 'replay';
export type LogoColour = 'truecolour' | '256' | '16' | 'none';
export const LOGO_DURATION_MS = 1320;
export const PLAIN_LOGO = 'Meet Tally\nthe CFO for your agent fleet';
const RESET = '\x1b[0m';
const HEIGHT = 12;
const WIDTH = 22;

export function logoTarget(argv: string[]): LogoTarget | undefined {
  if (!argv.length) return 'bare';
  if (argv.some(arg => ['--json', '--version', '-v'].includes(arg))) return undefined;
  if (argv[0] === '--help' || argv[0] === '-h') return 'help';
  if (argv[0] === 'logo') return 'replay';
  if (argv[0] === 'init' && !argv.includes('--help') && !argv.includes('-h')) return 'init';
  return undefined;
}

export function logoColour(env: NodeJS.ProcessEnv): LogoColour {
  if (env.NO_COLOR !== undefined || env.TERM === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) return 'truecolour';
  if (/256color/i.test(env.TERM ?? '')) return '256';
  return '16';
}

export function logoPolicy(target: LogoTarget, seen: boolean, tty: boolean, columns: number, env: NodeJS.ProcessEnv, rows = 24): 'animate' | 'static' | 'skip' {
  if (!tty || env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return 'skip';
  const frameRows = columns < 57 ? HEIGHT + 3 : HEIGHT;
  const suppressed = env.NO_COLOR !== undefined || env.TERM === 'dumb' || env.TALLY_NO_ANIMATION === '1' || columns < 24 || rows < frameRows + 2;
  if (!suppressed && (target === 'replay' || !seen && (target === 'bare' || target === 'init'))) return 'animate';
  return target === 'init' ? 'skip' : 'static';
}

function ink(colour: LogoColour): string {
  return colour === 'truecolour' ? '\x1b[38;2;239;77;28m'
    : colour === '256' ? '\x1b[38;5;202m' : colour === '16' ? '\x1b[91m' : '';
}

// A terminal cell holds two square pixels. Layer the slash over the strokes.
export function logoPixels(progress: number): number[][] {
  const p = Math.min(1, Math.max(0, progress));
  const pixels = Array.from({ length: HEIGHT * 2 }, () => Array<number>(WIDTH).fill(0));
  for (let i = 0; i < 4; i++) {
    const top = [2, 1, 3, 2][i]!;
    const bottom = 22;
    const drawn = Math.min(1, Math.max(0, (p - i * 0.13) / 0.18));
    for (let y = top; y <= top + (bottom - top) * drawn && drawn > 0; y++) {
      const x = [4, 9, 14, 19][i]! + (i === 0 && y > 10 || i === 3 && y > 15 ? 1 : 0);
      pixels[y]![x] = 1;
      pixels[y]![x + 1] = 1;
    }
  }
  if (p >= 0.59) {
    const blink = p > 0.66 && p < 0.70;
    for (const x of [12, 17]) {
      pixels[6]![x] = 1;
      if (!blink) pixels[7]![x] = 1;
    }
  }
  const slash = Math.min(1, Math.max(0, (p - 0.71) / 0.19));
  for (let x = 0; x < WIDTH * slash; x++) {
    const y = Math.round(17 - x * 0.43);
    pixels[y]![x] = 2;
    pixels[y + 1]![x] = 2;
  }
  return pixels;
}

export function logoFrame(progress: number, colour: LogoColour = 'truecolour', columns = 80): string[] {
  const pixels = logoPixels(progress);
  const orange = ink(colour);
  const fg = (value: number) => value === 2 ? orange : colour === 'none' ? '' : '\x1b[39m';
  const bg = (value: number) => value === 2 ? orange.replace('[38;', '[48;').replace('[91m', '[101m') : '\x1b[49m';
  const lines: string[] = [];
  for (let row = 0; row < HEIGHT; row++) {
    let line = '';
    for (let x = 0; x < WIDTH; x++) {
      const top = pixels[row * 2]![x]!;
      const bottom = pixels[row * 2 + 1]![x]!;
      if (row === 3 && (x === 12 || x === 17) && top) line += bottom ? '●' : '─';
      else if (!top && !bottom) line += ' ';
      else if (top === bottom) line += `${fg(top)}█${colour === 'none' ? '' : RESET}`;
      else if (!bottom) line += `${fg(top)}▀${colour === 'none' ? '' : RESET}`;
      else if (!top) line += `${fg(bottom)}▄${colour === 'none' ? '' : RESET}`;
      else if (top === 2) line += `${fg(bottom)}${colour === 'none' ? '' : bg(top)}▄${colour === 'none' ? '' : RESET}`;
      else line += `${fg(top)}${colour === 'none' ? '' : bg(bottom)}▀${colour === 'none' ? '' : RESET}`;
    }
    if (columns >= 57 && progress >= 0.90) {
      if (row === 4) line += `    ${colour === 'none' ? '' : '\x1b[1m'}Meet Tally${colour === 'none' ? '' : RESET}`;
      if (row === 6) line += '    the CFO for your agent fleet';
    }
    lines.push(line);
  }
  if (columns < 57) {
    lines.push('', ...PLAIN_LOGO.split('\n').map(line => progress >= 0.90 ? line.slice(0, columns - 1) : ''));
  }
  return lines;
}

export interface LogoOptions {
  output?: Pick<WriteStream, 'write' | 'isTTY' | 'columns'> & { rows?: number };
  env?: NodeJS.ProcessEnv;
  home?: string;
  signals?: {
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
  };
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/** Own only this short presentation; never install global signal handlers for commands. */
export async function presentLogo(target: LogoTarget, options: LogoOptions = {}): Promise<number> {
  const output = options.output ?? process.stdout;
  const env = options.env ?? process.env;
  const columns = output.columns || 80;
  const marker = join(options.home ?? homedir(), '.tally', 'welcome-v1');
  const policy = logoPolicy(target, existsSync(marker), !!output.isTTY, columns, env, output.rows || 24);
  if (policy === 'skip') return 0;
  if (policy === 'static') {
    const plain = env.NO_COLOR !== undefined || env.TERM === 'dumb' || env.CI !== undefined || env.TALLY_NO_ANIMATION === '1' || columns < 24;
    output.write(plain ? `${PLAIN_LOGO.split('\n').map(line => line.slice(0, Math.max(1, columns - 1))).join('\n')}\n\n`
      : columns >= 48 ? `${ink(logoColour(env))}╱${RESET} ||||  Tally · the CFO for your agent fleet\n\n` : `${ink(logoColour(env))}╱${RESET} ||||  Tally\n\n`);
    return 0;
  }
  const colour = logoColour(env);
  const rows = logoFrame(0, colour, columns).length;
  const signals = options.signals ?? process;
  const abort = new AbortController();
  let code = 0;
  let cleaned = false;
  const up = `\x1b[${rows}A`;
  const clear = () => output.write(('\r\x1b[2K\n').repeat(rows) + up + '\r');
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (code) clear();
    else output.write(`\x1b[${rows}B\r\n`);
    output.write(`${RESET}\x1b[?25h`);
  };
  const interrupt = () => { code = 130; abort.abort(); };
  const terminate = () => { code = 143; abort.abort(); };
  const exit = () => { code ||= 130; cleanup(); };
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  signals.on('exit', exit);
  try {
    output.write('\x1b[?25l' + '\n'.repeat(rows) + up);
    const frames = 34;
    for (let frame = 0; frame <= frames && !abort.signal.aborted; frame++) {
      output.write(logoFrame(frame / frames, colour, columns).map(line => `\r\x1b[2K${line}\n`).join('') + up + '\r');
      if (frame < frames) await (options.pause ?? pause)(LOGO_DURATION_MS / frames, abort.signal);
    }
    if (!code && target !== 'replay') {
      // A skipped or interrupted welcome must not consume the user's first run.
      try {
        mkdirSync(join(options.home ?? homedir(), '.tally'), { recursive: true, mode: 0o700 });
        writeFileSync(marker, 'seen\n', { mode: 0o600, flag: 'wx' });
      } catch { /* Read-only homes must not prevent using Tally. */ }
    }
  } catch (error) {
    code ||= 130;
    throw error;
  } finally {
    cleanup();
    signals.removeListener('SIGINT', interrupt);
    signals.removeListener('SIGTERM', terminate);
    signals.removeListener('exit', exit);
  }
  return code;
}
