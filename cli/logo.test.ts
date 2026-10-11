import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_WIDTH, FRAME_MS, FULL_ROWS, FULL_WIDTH, SETTLED, TIMELINE,
  compactLogo, logoFrame, logoFrames, logoMarkerPath, logoStateAt, planLogo, playLogo, showLogo, staticLogo, visibleWidth,
  type LogoContext, type LogoTerminal,
} from './logo.js';

const context = (over: Partial<LogoContext> = {}): LogoContext => ({
  intent: 'bare', interactive: true, env: { TERM: 'xterm-256color' }, isTTY: true, columns: 100, rows: 30, colorDepth: 24, seen: false, ...over,
});

function fakeTerminal() {
  const written: string[] = [];
  const state = { interrupt: null as null | ((exitCode: number) => void), removed: 0, exitCode: null as number | null, sleeps: 0 };
  const terminal: LogoTerminal = {
    write: (text) => void written.push(text),
    sleep: async () => { state.sleeps += 1; },
    onInterrupt: (handler) => { state.interrupt = handler; return () => { state.removed += 1; }; },
    exit: (code) => { state.exitCode = code; },
  };
  return { terminal, written, state };
}

describe('when the logo shows', () => {
  it('animates once on the first bare tally or tally init, then only a still mark on bare tally and help', () => {
    expect(planLogo(context())).toEqual({ show: 'animate', color: 'truecolor', markSeen: true });
    expect(planLogo(context({ intent: 'init' }))).toEqual({ show: 'animate', color: 'truecolor', markSeen: true });
    expect(planLogo(context({ seen: true }))).toEqual({ show: 'static', color: 'truecolor', markSeen: false });
    expect(planLogo(context({ intent: 'help' }))).toEqual({ show: 'static', color: 'truecolor', markSeen: false });
    expect(planLogo(context({ intent: 'init', seen: true })).show).toBe('none');
  });

  it('never shows for run, doctor or any other command', () => {
    for (const seen of [true, false]) expect(planLogo(context({ intent: 'other', seen })).show).toBe('none');
  });

  it('stays silent off a terminal, in CI, on a dumb terminal and for scripted init', () => {
    for (const intent of ['bare', 'help', 'init', 'logo'] as const) {
      expect(planLogo(context({ intent, isTTY: false })).show).toBe('none');
      expect(planLogo(context({ intent, env: { CI: 'true' } })).show).toBe('none');
      expect(planLogo(context({ intent, env: { TERM: 'dumb' } })).show).toBe('none');
    }
    expect(planLogo(context({ intent: 'init', interactive: false })).show).toBe('none');
    expect(planLogo(context({ env: { CI: 'false' } })).show).toBe('animate');
  });

  it('shows plain uncoloured still text under NO_COLOR', () => {
    expect(planLogo(context({ env: { NO_COLOR: '1' } }))).toEqual({ show: 'static', color: 'none', markSeen: true });
    expect(planLogo(context({ intent: 'logo', env: { NO_COLOR: '1' } }))).toEqual({ show: 'static', color: 'none', markSeen: false });
    expect(planLogo(context({ env: { NO_COLOR: '' } })).show).toBe('animate');
  });

  it('TALLY_NO_ANIMATION keeps the still mark and does not use up the first run', () => {
    expect(planLogo(context({ env: { TALLY_NO_ANIMATION: '1' } }))).toEqual({ show: 'static', color: 'truecolor', markSeen: false });
    expect(planLogo(context({ intent: 'init', env: { TALLY_NO_ANIMATION: '1' } })).show).toBe('none');
    expect(planLogo(context({ intent: 'logo', env: { TALLY_NO_ANIMATION: '1' } })).show).toBe('static');
  });

  it('degrades colour with the terminal and replays on tally logo without touching the marker', () => {
    expect(planLogo(context({ colorDepth: 8 })).color).toBe('256');
    expect(planLogo(context({ colorDepth: 4 })).color).toBe('16');
    expect(planLogo(context({ colorDepth: 1 }))).toEqual({ show: 'static', color: 'none', markSeen: true });
    expect(planLogo(context({ intent: 'logo', seen: true }))).toEqual({ show: 'animate', color: 'truecolor', markSeen: false });
  });

  it('falls back to the still mark, then to nothing, as the terminal narrows', () => {
    expect(planLogo(context({ columns: FULL_WIDTH })).show).toBe('static');
    expect(planLogo(context({ columns: FULL_WIDTH + 1 })).show).toBe('animate');
    expect(planLogo(context({ columns: COMPACT_WIDTH })).show).toBe('none');
    expect(planLogo(context({ rows: FULL_ROWS + 2 })).show).toBe('static');
    expect(planLogo(context({ rows: FULL_ROWS + 3 })).show).toBe('animate');
  });
});

describe('frames', () => {
  it('draws strokes one at a time, then the eyes with a blink, then the slash, then the text', () => {
    expect(logoStateAt(0).strokes).toEqual([0, 0, 0, 0]);
    const second = logoStateAt(TIMELINE.stroke + FRAME_MS);
    expect(second.strokes[0]).toBe(SETTLED.strokes[0]);
    expect(second.strokes[1]).toBeGreaterThan(0);
    expect(second.strokes[2]).toBe(0);
    expect(logoStateAt(TIMELINE.eyes - 1).eyes).toBe(false);
    expect(logoStateAt(TIMELINE.eyes).eyes).toBe(true);
    expect(logoStateAt(TIMELINE.blinkShut).eyes).toBe(false);
    expect(logoStateAt(TIMELINE.blinkOpen).eyes).toBe(true);
    expect(logoFrame(logoStateAt(TIMELINE.eyes), 'none')[2]).toBe('   █   █ ▀ █ ▀ █');
    expect(logoFrame(logoStateAt(TIMELINE.blinkShut), 'none')[2]).toBe('   █   █ ▔ █ ▔ █');
    expect(logoFrame(logoStateAt(TIMELINE.blinkOpen), 'none')[2]).toBe('   █   █ ▀ █ ▀ █');
    expect(logoStateAt(TIMELINE.slash - 1)).toMatchObject({ slash: 0, text: 0 });
    expect(logoStateAt(TIMELINE.text - FRAME_MS).slash).toBe(SETTLED.slash);
    expect(logoStateAt(TIMELINE.text).text).toBe(1);
    expect(logoStateAt(TIMELINE.end)).toEqual(SETTLED);
  });

  it('lasts between one and one and a half seconds and every frame fits the same box', () => {
    const frames = logoFrames('truecolor');
    expect((frames.length - 1) * FRAME_MS).toBeGreaterThanOrEqual(1000);
    expect((frames.length - 1) * FRAME_MS).toBeLessThanOrEqual(1500);
    for (const frame of frames) {
      expect(frame).toHaveLength(FULL_ROWS);
      for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(FULL_WIDTH);
    }
    expect(frames.at(-1)).toEqual(logoFrame(SETTLED, 'truecolor'));
  });

  it('settles on the mark beside Meet, Tally and the tagline', () => {
    expect(logoFrame(SETTLED, 'none')).toMatchInlineSnapshot(`
      [
        "   ▄   █       ▄       Meet",
        "   █   █   █   █       █████████         ▀██  ▀██",
        "   █   █ ▀ █ ▀ █  ▄    ▀  ███  ▀          ██   ██",
        "   █   █   █  ▄█▀▀        ███    ▄█▀▀█▄   ██   ██  ██   ██",
        "   █   █  ▄█▀▀ █          ███     ▄▄▄██   ██   ██  ▀█▄ ▄█▀",
        "   █  ▄█▀▀ █   █          ███    ██  ██   ██   ██   ▀█▄█▀",
        "  ▄█▀▀ █   █   █         ▄███▄   ▀█▄▄▀█▄ ▄██▄ ▄██▄   ██▀",
        "▀▀ █   █   █   █                                    ▄█▀",
        "   █   █   █   █                                   ██▀",
        "   █   █   █   ▀       the CFO for your agent fleet",
      ]
    `);
    expect(compactLogo('none')).toMatchInlineSnapshot(`
      [
        " ▄  █  ▄  █    Tally",
        " █  █▄▄█▀▀█▀   the CFO for your agent fleet",
        "▀█▀▀█  █  █",
      ]
    `);
  });

  it('colours only the slash, and writes no escape codes at all without colour', () => {
    const plain = [...logoFrame(SETTLED, 'none'), ...compactLogo('none')].join('\n');
    expect(plain).not.toContain('\x1b');
    const mark = logoFrame({ ...SETTLED, text: 0 }, 'truecolor').join('\n');
    expect(mark).toContain('\x1b[38;2;226;88;34m');
    expect(logoFrame({ ...SETTLED, slash: 0, text: 0 }, 'truecolor').join('\n')).not.toContain('\x1b');
    expect(logoFrame(SETTLED, '256').join('\n')).toContain('\x1b[38;5;202m');
    expect(logoFrame(SETTLED, '16').join('\n')).toContain('\x1b[91m');
  });
});

describe('playing', () => {
  it('hides the cursor, redraws in place and always restores the cursor', async () => {
    const { terminal, written, state } = fakeTerminal();
    await playLogo(terminal, 'truecolor');
    const all = written.join('');
    expect(written[0]).toContain('\x1b[?25l');
    expect(written.at(-1)).toBe('\x1b[0m\x1b[?25h');
    expect(all.split(`\x1b[${FULL_ROWS}A`).length - 1).toBe(logoFrames('truecolor').length - 1);
    expect(state.sleeps).toBe(logoFrames('truecolor').length - 1);
    expect(state.removed).toBe(1);
  });

  it('restores the cursor and exits 130 on Ctrl+C, and when a write fails', async () => {
    const { terminal, written, state } = fakeTerminal();
    terminal.sleep = async () => { state.interrupt?.(130); };
    await playLogo(terminal, 'truecolor');
    expect(state.exitCode).toBe(130);
    const stopped = fakeTerminal();
    stopped.terminal.sleep = async () => { stopped.state.interrupt?.(143); };
    await playLogo(stopped.terminal, 'truecolor');
    expect(stopped.state.exitCode).toBe(143);
    expect(stopped.written.join('')).toContain('\x1b[0m\x1b[?25h\n');
    expect(written.join('')).toContain('\x1b[0m\x1b[?25h\n');

    const broken = fakeTerminal();
    broken.terminal.sleep = async () => { throw new Error('closed'); };
    await expect(playLogo(broken.terminal, 'truecolor')).rejects.toThrow('closed');
    expect(broken.written.at(-1)).toBe('\x1b[0m\x1b[?25h');
    expect(broken.state.removed).toBe(1);
  });
});

describe('the once-only marker', () => {
  it('is written by the first run only, under .tally in the home directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-logo-'));
    try {
      const marker = logoMarkerPath(home);
      expect(marker).toBe(join(home, '.tally', 'logo-seen'));
      await showLogo(context({ intent: 'help' }), fakeTerminal().terminal, marker);
      await showLogo(context({ intent: 'logo' }), fakeTerminal().terminal, marker);
      await showLogo(context({ intent: 'other' }), fakeTerminal().terminal, marker);
      expect(existsSync(marker)).toBe(false);
      const first = fakeTerminal();
      expect((await showLogo(context(), first.terminal, marker)).show).toBe('animate');
      expect(existsSync(marker)).toBe(true);
      const later = fakeTerminal();
      expect((await showLogo(context({ seen: true }), later.terminal, marker)).show).toBe('static');
      expect(later.written.join('')).toBe(staticLogo('bare', 'truecolor', 100));
      expect(later.written.join('')).not.toContain('\x1b[?25l');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
