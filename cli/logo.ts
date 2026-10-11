/**
 * The Tally mark in the terminal: four hand-drawn strokes with two eyes,
 * struck through by one orange slash, beside "Meet Tally".
 *
 * Everything is drawn with half-block characters, so one character cell holds
 * two square pixels. Strokes use the terminal's own foreground colour and
 * therefore read on light and dark backgrounds alike; only the slash is coloured.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type LogoColor = 'none' | '16' | '256' | 'truecolor';
export type LogoShow = 'animate' | 'static' | 'none';
export type LogoIntent = 'bare' | 'help' | 'init' | 'logo' | 'other';

export interface LogoPlan {
  show: LogoShow;
  color: LogoColor;
  /** True when this showing uses up the once-only first run. */
  markSeen: boolean;
}

export interface LogoContext {
  intent: LogoIntent;
  /** False when the command was asked to run without prompts or to print for a machine. */
  interactive: boolean;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  columns: number;
  /** Terminal height in rows. */
  rows: number;
  /** Bits of colour the terminal reports: 1, 4, 8 or 24. */
  colorDepth: number;
  /** Whether the first-run animation has already played on this machine. */
  seen: boolean;
}

const INK = 1;
const SLASH = 2;
type Pixel = 0 | typeof INK | typeof SLASH;

const MARK_WIDTH = 19;
const MARK_HEIGHT = 20;
/** Column, top pixel and bottom pixel of each stroke. The tops are uneven on purpose. */
const STROKES = [
  { x: 3, top: 1, bottom: 19 },
  { x: 7, top: 0, bottom: 19 },
  { x: 11, top: 2, bottom: 19 },
  { x: 15, top: 1, bottom: 18 },
] as const;
const EYES = [
  { x: 9, y: 4 },
  { x: 13, y: 4 },
] as const;
/** The slash rises one pixel for every two columns, left to right. */
const slashY = (x: number): number => 14 - Math.floor(x / 2);

/** "Tally" as pixels, sixteen high: cap height twelve, with four below the line for the y. */
const LETTERS = {
  T: ['#########', '#########', '#..###..#', '...###...', '...###...', '...###...', '...###...', '...###...', '...###...', '...###...', '...###...', '..#####..', '', '', '', ''],
  a: ['', '', '', '', '.####..', '##..##.', '....##.', '.#####.', '##..##.', '##..##.', '##..##.', '.###.##', '', '', '', ''],
  l: ['###.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '####', '', '', '', ''],
  y: ['', '', '', '', '##...##', '##...##', '##...##', '.##.##.', '.##.##.', '..###..', '..###..', '..##...', '..##...', '.##....', '###....', '##.....'],
} as const;
const letterRow = (letter: keyof typeof LETTERS, y: number): string => LETTERS[letter][y]!.padEnd(LETTERS[letter][0]!.length || LETTERS[letter][4]!.length, '.');
const WORDMARK = Array.from({ length: 16 }, (_, y) => (['T', 'a', 'l', 'l', 'y'] as const).map((letter) => letterRow(letter, y)).join('.'));
const WORDMARK_WIDTH = Math.max(...WORDMARK.map((row) => row.length));
const MEET = 'Meet';
const TAGLINE = 'the CFO for your agent fleet';
const TEXT_GAP = 4;
const TEXT_SLIDE = 2;

export const FULL_WIDTH = MARK_WIDTH + TEXT_GAP + Math.max(WORDMARK_WIDTH, TAGLINE.length) + TEXT_SLIDE;
export const FULL_ROWS = MARK_HEIGHT / 2;
export const COMPACT_WIDTH = 12 + 3 + TAGLINE.length;

/** Milliseconds at which each part of the animation starts; `end` is its length. */
export const TIMELINE = { stroke: 120, eyes: 500, blinkShut: 640, blinkOpen: 720, slash: 800, text: 980, end: 1280 } as const;
export const FRAME_MS = 40;

export interface LogoState {
  /** Pixels of each stroke drawn so far, from its top. */
  strokes: number[];
  eyes: boolean;
  /** True for the two frames in which the eyes are shut. */
  blink?: boolean;
  /** Columns of the slash drawn so far, from the left. */
  slash: number;
  /** 0 hidden, 1 arriving (dim, offset), 2 nearly there, 3 settled. */
  text: 0 | 1 | 2 | 3;
}

export const SETTLED: LogoState = { strokes: STROKES.map((s) => s.bottom - s.top + 1), eyes: true, slash: MARK_WIDTH, text: 3 };

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** What is on screen `ms` into the animation. */
export function logoStateAt(ms: number): LogoState {
  if (ms >= TIMELINE.end) return SETTLED;
  const strokes = STROKES.map((s, i) => Math.round(clamp01((ms - i * TIMELINE.stroke) / TIMELINE.stroke) * (s.bottom - s.top + 1)));
  const eyes = ms >= TIMELINE.eyes && !(ms >= TIMELINE.blinkShut && ms < TIMELINE.blinkOpen);
  // The slash is a strike: fast at first, easing out at the end.
  const p = clamp01((ms - TIMELINE.slash) / (TIMELINE.text - TIMELINE.slash - FRAME_MS));
  const slash = ms < TIMELINE.slash ? 0 : Math.round((1 - (1 - p) ** 2) * MARK_WIDTH);
  const sinceText = ms - TIMELINE.text;
  const text = sinceText < 0 ? 0 : sinceText < 100 ? 1 : sinceText < 200 ? 2 : 3;
  return { strokes, eyes, blink: ms >= TIMELINE.blinkShut && ms < TIMELINE.blinkOpen, slash, text };
}

function markPixels(state: LogoState): Pixel[][] {
  const grid: Pixel[][] = Array.from({ length: MARK_HEIGHT }, () => Array<Pixel>(MARK_WIDTH).fill(0));
  STROKES.forEach((s, i) => {
    for (let y = s.top; y < s.top + (state.strokes[i] ?? 0) && y <= s.bottom; y++) grid[y]![s.x] = INK;
  });
  if (state.eyes) for (const eye of EYES) grid[eye.y]![eye.x] = INK;
  for (let x = 0; x < state.slash && x < MARK_WIDTH; x++) grid[slashY(x)]![x] = SLASH;
  return grid;
}

function wordmarkPixels(): Pixel[][] {
  return WORDMARK.map((row) => Array.from({ length: WORDMARK_WIDTH }, (_, x) => (row[x] === '#' ? INK : 0)));
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const SLASH_FG: Record<Exclude<LogoColor, 'none'>, string> = { truecolor: '38;2;226;88;34', '256': '38;5;202', '16': '91' };
const SLASH_BG: Record<Exclude<LogoColor, 'none'>, string> = { truecolor: '48;2;226;88;34', '256': '48;5;202', '16': '101' };

/** Wraps `text` in an SGR style, or returns it bare when colour is off. */
function styled(text: string, sgr: string, color: LogoColor): string {
  return color === 'none' || sgr === '' || text.trim() === '' ? text : `${ESC}${sgr}m${text}${RESET}`;
}

/** Two pixel rows become one line of half blocks. `sgr` styles the ink. */
function halfBlocks(top: Pixel[], bottom: Pixel[], color: LogoColor, sgr = ''): string {
  let line = '';
  let run = '';
  let runStyle = '';
  const flush = (): void => {
    line += styled(run, runStyle, color);
    run = '';
  };
  for (let x = 0; x < top.length; x++) {
    const a = top[x]!;
    const b = bottom[x]!;
    let char = ' ';
    let style = '';
    if (a !== 0 && b !== 0 && a !== b) {
      // Ink and slash share the cell: paint the slash as background and let the ink keep the foreground.
      char = color === 'none' ? '█' : a === INK ? '▀' : '▄';
      style = color === 'none' ? '' : [sgr, SLASH_BG[color]].filter(Boolean).join(';');
    } else if (a !== 0 || b !== 0) {
      char = a !== 0 && b !== 0 ? '█' : a !== 0 ? '▀' : '▄';
      style = (a || b) === SLASH && color !== 'none' ? SLASH_FG[color] : sgr;
    }
    if (style !== runStyle) {
      flush();
      runStyle = style;
    }
    run += char;
  }
  flush();
  return line.replace(/ +$/, '');
}

function rowsOf(pixels: Pixel[][], color: LogoColor, sgr = ''): string[] {
  const rows: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) rows.push(halfBlocks(pixels[y]!, pixels[y + 1]!, color, sgr));
  return rows;
}

/** Visible width of a line, ignoring colour codes. */
export function visibleWidth(line: string): number {
  // eslint-disable-next-line no-control-regex
  return [...line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length;
}

const padTo = (line: string, width: number): string => line + ' '.repeat(Math.max(0, width - visibleWidth(line)));

/** The large mark with its text, as `FULL_ROWS` lines. */
export function logoFrame(state: LogoState, color: LogoColor): string[] {
  const lines = rowsOf(markPixels(state), color);
  if (state.blink) {
    // Shut eyes are a thin line where each eye was. Nothing on this row is coloured yet, so columns are characters.
    const row = [...padTo(lines[EYES[0].y / 2]!, MARK_WIDTH)];
    for (const eye of EYES) row[eye.x] = '▔';
    lines[EYES[0].y / 2] = row.join('').replace(/ +$/, '');
  }
  if (state.text === 0) return lines;
  const dim = state.text === 1 ? '2' : '';
  const offset = TEXT_GAP + (state.text === 1 ? TEXT_SLIDE : state.text === 2 ? 1 : 0);
  const put = (row: number, text: string): void => {
    lines[row] = padTo(lines[row]!, MARK_WIDTH) + ' '.repeat(offset) + text;
  };
  put(0, styled(MEET, [dim, '3'].filter(Boolean).join(';'), color));
  rowsOf(wordmarkPixels(), color, [dim, '1'].filter(Boolean).join(';')).forEach((row, i) => put(1 + i, row));
  if (state.text >= 2) put(9, styled(TAGLINE, state.text === 2 ? '2' : '', color));
  return lines;
}

const COMPACT_STROKES = [1, 4, 7, 10];
const COMPACT_COLUMNS = 12;
const COMPACT_HEIGHT = 6;

/** The small mark shown above the help text once the first run is over. */
export function compactLogo(color: LogoColor): string[] {
  const grid: Pixel[][] = Array.from({ length: COMPACT_HEIGHT }, () => Array<Pixel>(COMPACT_COLUMNS).fill(0));
  COMPACT_STROKES.forEach((x, i) => {
    for (let y = (i + 1) % 2; y < COMPACT_HEIGHT; y++) grid[y]![x] = INK;
  });
  for (let x = 0; x < COMPACT_COLUMNS; x++) grid[4 - Math.floor(x / 4)]![x] = SLASH;
  const rows = rowsOf(grid, color);
  return [
    `${padTo(rows[0]!, COMPACT_COLUMNS)}   ${styled('Tally', '1', color)}`,
    `${padTo(rows[1]!, COMPACT_COLUMNS)}   ${TAGLINE}`,
    rows[2]!,
  ];
}

const truthy = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

function colorOf(env: LogoContext['env'], depth: number): LogoColor {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (depth >= 24) return 'truecolor';
  if (depth >= 8) return '256';
  return depth >= 4 ? '16' : 'none';
}

/** Decides whether to animate, show the still mark, or stay silent. */
export function planLogo(context: LogoContext): LogoPlan {
  const { intent, env } = context;
  const none: LogoPlan = { show: 'none', color: 'none', markSeen: false };
  if (intent === 'other') return none;
  const color = colorOf(env, context.colorDepth);
  if (!context.isTTY || truthy(env.CI) || env.TERM === 'dumb') return none;
  if (!context.interactive) return none;

  const firstRun = !context.seen && (intent === 'bare' || intent === 'init');
  const wantsMotion = intent === 'logo' || firstRun;
  const still = (markSeen: boolean): LogoPlan => (context.columns >= COMPACT_WIDTH + 1 ? { show: 'static', color, markSeen } : none);

  if (wantsMotion && color !== 'none' && !truthy(env.TALLY_NO_ANIMATION) && context.columns >= FULL_WIDTH + 1 && context.rows >= FULL_ROWS + 3) {
    return { show: 'animate', color, markSeen: firstRun };
  }
  // No colour, no motion or no room: `init` only ever shows the mark as its first-run greeting.
  if (intent === 'init') return firstRun && !truthy(env.TALLY_NO_ANIMATION) ? still(true) : none;
  return still(firstRun && !truthy(env.TALLY_NO_ANIMATION));
}

export interface LogoTerminal {
  write: (text: string) => void;
  /** Resolves after `ms`. */
  sleep: (ms: number) => Promise<void>;
  /** Registers a handler for Ctrl+C and for termination, and returns a function that removes it. */
  onInterrupt: (handler: (exitCode: number) => void) => () => void;
  /** Ends the process after an interrupt. */
  exit: (code: number) => void;
}

const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

/** Every frame of the animation, first to last. The last is the settled logo. */
export function logoFrames(color: LogoColor): string[][] {
  const frames: string[][] = [];
  for (let ms = 0; ms < TIMELINE.end; ms += FRAME_MS) frames.push(logoFrame(logoStateAt(ms), color));
  frames.push(logoFrame(SETTLED, color));
  return frames;
}

/**
 * Plays the animation in place. The cursor is hidden while it runs and is
 * restored when it ends, when it throws, on Ctrl+C and when the process is told to stop.
 */
export async function playLogo(terminal: LogoTerminal, color: LogoColor): Promise<void> {
  const restore = `${RESET}${SHOW_CURSOR}`;
  const removeInterrupt = terminal.onInterrupt((exitCode) => {
    terminal.write(`${restore}\n`);
    terminal.exit(exitCode);
  });
  try {
    terminal.write(`${HIDE_CURSOR}\n`);
    const frames = logoFrames(color);
    for (const [index, frame] of frames.entries()) {
      const rewind = index === 0 ? '' : `${ESC}${FULL_ROWS}A`;
      terminal.write(rewind + frame.map((line) => `\r${ESC}2K ${line}\n`).join(''));
      if (index < frames.length - 1) await terminal.sleep(FRAME_MS);
    }
    terminal.write('\n');
  } finally {
    removeInterrupt();
    terminal.write(restore);
  }
}

/** The still logo: large for `tally logo`, compact above the help text. */
export function staticLogo(intent: LogoIntent, color: LogoColor, columns: number): string {
  const lines = intent === 'logo' && columns >= FULL_WIDTH + 1 ? logoFrame(SETTLED, color) : compactLogo(color);
  return `\n${lines.map((line) => ` ${line}`.replace(/ +$/, '')).join('\n')}\n\n`;
}

export function logoMarkerPath(home: string = homedir()): string {
  return join(home, '.tally', 'logo-seen');
}

export const logoSeen = (path: string = logoMarkerPath()): boolean => existsSync(path);

/** Records that the first-run animation has played. A home that cannot be written to is not an error. */
export function markLogoSeen(path: string = logoMarkerPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`);
  } catch {
    /* the animation simply plays again next time */
  }
}

/** The real terminal, for the CLI entry point. */
export function processTerminal(): LogoTerminal {
  return {
    write: (text) => void process.stdout.write(text),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    onInterrupt: (handler) => {
      const interrupt = (): void => handler(130);
      const terminate = (): void => handler(143);
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      return () => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
      };
    },
    exit: (code) => process.exit(code),
  };
}

/** Shows the logo for this invocation, if it should be shown at all. */
export async function showLogo(context: LogoContext, terminal: LogoTerminal, markerPath: string = logoMarkerPath()): Promise<LogoPlan> {
  const plan = planLogo(context);
  if (plan.show === 'none') return plan;
  // Mark first, so an interrupted first run does not replay on every later command.
  if (plan.markSeen) markLogoSeen(markerPath);
  if (plan.show === 'animate') await playLogo(terminal, plan.color);
  else terminal.write(staticLogo(context.intent, plan.color, context.columns));
  return plan;
}
