import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logoColour, logoFrame, logoPixels, logoPolicy, logoTarget, presentLogo } from './logo.js';

const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
function fixture(columns = 80, isTTY = true) {
  const home = mkdtempSync(join(tmpdir(), 'tally-logo-'));
  const writes: string[] = [];
  const signals = new EventEmitter();
  const output = { columns, isTTY, write: (value: string | Uint8Array) => { writes.push(String(value)); return true; } };
  return { home, writes, signals, output, env: { TERM: 'xterm-256color' }, pause: async () => {} };
}

describe('logo gates', () => {
  it('limits the welcome to bare tally/init, and offers explicit replay/static help', () => {
    expect(logoTarget([])).toBe('bare');
    expect(logoTarget(['init', '--yes'])).toBe('init');
    expect(logoTarget(['logo'])).toBe('replay');
    expect(logoTarget(['--help'])).toBe('help');
    for (const args of [['run'], ['doctor'], ['demo'], ['run', '--help'], ['init', '--help'], ['init', '--json'], ['--version']]) expect(logoTarget(args)).toBeUndefined();
    expect(logoPolicy('bare', false, true, 80, {})).toBe('animate');
    expect(logoPolicy('init', false, true, 80, {})).toBe('animate');
    expect(logoPolicy('help', false, true, 80, {})).toBe('static');
    expect(logoPolicy('bare', true, true, 80, {})).toBe('static');
    expect(logoPolicy('init', true, true, 80, {})).toBe('skip');
    expect(logoPolicy('replay', true, true, 80, {})).toBe('animate');
  });
  it.each([{ NO_COLOR: '' }, { TERM: 'dumb' }, { TALLY_NO_ANIMATION: '1' }])('suppresses motion for %j, even replay', env => {
    expect(logoPolicy('bare', false, true, 80, env)).toBe('static');
    expect(logoPolicy('replay', false, true, 80, env)).toBe('static');
    expect(logoPolicy('init', false, true, 80, env)).toBe('skip');
  });
  it('never emits decoration to pipes and never wraps a tiny animation', async () => {
    const f = fixture(80, false);
    await presentLogo('replay', f);
    expect(f.writes).toEqual([]);
    expect(existsSync(join(f.home, '.tally'))).toBe(false);
    expect(logoPolicy('bare', false, true, 20, {})).toBe('static');
    expect(logoPolicy('bare', false, true, 80, {}, 10)).toBe('static');
    expect(logoPolicy('bare', false, true, 40, {}, 15)).toBe('static');
    expect(logoPolicy('bare', false, true, 80, { CI: 'true' })).toBe('skip');
    expect(logoPolicy('replay', false, true, 80, { CI: '1' })).toBe('skip');
  });
  it('selects truecolour, 256, 16, or plain without assuming a light background', () => {
    expect(logoColour({ COLORTERM: 'truecolor' })).toBe('truecolour');
    expect(logoColour({ TERM: 'xterm-256color' })).toBe('256');
    expect(logoColour({ TERM: 'xterm' })).toBe('16');
    expect(logoColour({ NO_COLOR: '' })).toBe('none');
  });
});

describe('logo frames', () => {
  it('draws strokes individually downwards, then eyes, then the rising slash', () => {
    expect(logoPixels(0).flat().every(pixel => pixel === 0)).toBe(true);
    const first = logoPixels(0.10);
    expect(first.some(row => row[4] === 1)).toBe(true);
    expect(first.some(row => row[9] === 1)).toBe(false);
    expect(first[22]![5]).toBe(0);
    const eyes = logoPixels(0.63);
    expect(eyes[6]![12]).toBe(1);
    expect(eyes[6]![17]).toBe(1);
    expect(eyes.flat()).not.toContain(2);
    expect(logoPixels(0.68)[7]![12]).toBe(0);
    const final = logoPixels(1);
    expect(final[17]![0]).toBe(2);
    expect(final[8]![21]).toBe(2);
    expect(final[22]!.filter(pixel => pixel === 1)).toHaveLength(8);
  });
  it('keeps frame dimensions stable and only settles text at the end', () => {
    for (const columns of [24, 40, 56, 57, 80]) {
      const frames = [0, 0.2, 0.65, 0.8, 1].map(p => logoFrame(p, '256', columns));
      expect(new Set(frames.map(frame => frame.length)).size).toBe(1);
      for (const frame of frames) for (const line of frame) expect(strip(line).length).toBeLessThan(columns);
    }
    expect(logoFrame(0.8).join('')).not.toContain('Meet Tally');
    expect(logoFrame(1).join('')).toContain('Meet Tally');
    expect(logoFrame(1).join('')).toContain('the CFO for your agent fleet');
    expect(logoFrame(1, 'truecolour').join('')).toContain('38;2;239;77;28');
    expect(logoFrame(1, '256').join('')).toContain('38;5;202');
    expect(logoFrame(1, '16').join('')).toContain('[91m');
    expect(logoFrame(1, 'none').join('')).not.toContain('\x1b');
  });
});

describe('logo lifecycle', () => {
  it('plays once across bare/init and records only a completed welcome outside the repo', async () => {
    const f = fixture();
    expect(await presentLogo('bare', f)).toBe(0);
    const marker = join(f.home, '.tally', 'welcome-v1');
    expect(readFileSync(marker, 'utf8')).toBe('seen\n');
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(f.writes.join('')).toContain('\x1b[?25l');
    expect(f.writes.at(-1)).toBe('\x1b[0m\x1b[?25h');
    f.writes.length = 0;
    await presentLogo('init', f);
    expect(f.writes).toEqual([]);
    await presentLogo('bare', f);
    expect(f.writes.join('')).not.toContain('\x1b[?25l');
    expect(f.signals.eventNames()).toEqual([]);
  });
  it('replays without consuming the first-run marker', async () => {
    const f = fixture();
    await presentLogo('replay', f);
    expect(existsSync(join(f.home, '.tally', 'welcome-v1'))).toBe(false);
  });
  it.each(['SIGINT', 'SIGTERM'])('clears and restores the cursor on %s without consuming welcome', async signal => {
    const f = fixture();
    f.pause = async () => { f.signals.emit(signal); };
    expect(await presentLogo('bare', f)).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(existsSync(join(f.home, '.tally', 'welcome-v1'))).toBe(false);
    expect(f.writes.at(-1)).toBe('\x1b[0m\x1b[?25h');
    expect(f.writes.at(-2)).toContain('\x1b[2K');
    expect(f.signals.eventNames()).toEqual([]);
  });
  it('restores terminal state even when a frame delay fails', async () => {
    const f = fixture();
    f.pause = async () => { throw new Error('delay failed'); };
    await expect(presentLogo('replay', f)).rejects.toThrow('delay failed');
    expect(f.writes.at(-1)).toBe('\x1b[0m\x1b[?25h');
    expect(f.signals.eventNames()).toEqual([]);
  });
  it('prints plain static text for NO_COLOR without marker or cursor controls', async () => {
    const f = fixture();
    await presentLogo('bare', { ...f, env: { NO_COLOR: '' } });
    expect(f.writes.join('')).toBe('Meet Tally\nthe CFO for your agent fleet\n\n');
    expect(existsSync(join(f.home, '.tally', 'welcome-v1'))).toBe(false);
  });
});
