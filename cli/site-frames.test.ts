import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRAME_MS, compactLogo, logoFrames } from './logo.js';

// The project page promises the terminal replays the real CLI animation. The
// generator in site/tools/build-frames.mjs reads dist/, so this checks the
// committed frames against the source instead.
const committed = readFileSync(new URL('../site/logo-frames.js', import.meta.url), 'utf8');
const data = JSON.parse(committed.slice(committed.indexOf('window.TALLY_LOGO = ') + 'window.TALLY_LOGO = '.length).trim().replace(/;$/, '')) as { frameMs: number; frames: string[]; compact: string };
const visible = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// eslint-disable-next-line no-control-regex
const unstyled = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const plain = (lines: string[]) => lines.map((line) => ` ${line}`).join('\n');

describe('project page terminal frames', () => {
  it('are the CLI logo frames, in order, at the CLI frame rate', () => {
    expect(data.frameMs).toBe(FRAME_MS);
    expect(data.frames.map(visible)).toEqual(logoFrames('truecolor').map(plain).map(unstyled));
    expect(visible(data.compact)).toBe(unstyled(plain(compactLogo('truecolor'))));
  });
  it('colour the same cells the terminal colours', () => {
    const coloured = (lines: string[]) => lines.join('\n').split('\x1b[38;2;').length + lines.join('\n').split('\x1b[48;2;').length - 2;
    logoFrames('truecolor').forEach((frame, index) => {
      expect((data.frames[index]!.match(/class="[^"]*\bsb?\b[^"]*"/g) ?? []).length).toBe(coloured(frame));
    });
  });
  it('the page without JavaScript shows the settled frame', () => {
    const page = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
    expect(page).toContain(data.frames.at(-1)!);
  });
});
