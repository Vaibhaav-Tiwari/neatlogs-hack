import { describe, expect, it } from 'vitest';
import { createTerminalStyle, formatDoctorLine, formatInitLine, formatInitPrompt } from './terminal.js';

describe('terminal presentation', () => {
  it('keeps plain output readable and aligned when color is unavailable', () => {
    const style = createTerminalStyle({ isTTY: false, env: { TERM: 'dumb' } });
    expect(style.heading('TALLY')).toBe('TALLY');
    expect(formatDoctorLine({ product: 'Neatlogs key', status: 'connected', detail: 'key is set', fix: null }, style)).toEqual([
      '  ● CONNECTED      Neatlogs key',
      '      key is set',
    ]);
    expect(formatInitPrompt('Enable Neatlogs?', 'N', style)).toBe('› Enable Neatlogs? [N]: ');
  });

  it('uses the orange brand, green success, amber optional, and red failure tones in a TTY', () => {
    const style = createTerminalStyle({ isTTY: true, env: {} });
    expect(style.heading('TALLY')).toContain('\u001b[1;38;2;226;88;34m');
    expect(style.status('connected')).toContain('\u001b[1;38;2;76;175;80m');
    expect(style.status('unavailable')).toContain('\u001b[1;38;2;218;150;35m');
    expect(style.status('error')).toContain('\u001b[1;38;2;220;65;65m');
    expect(formatInitLine('  Neatlogs          on', style)).toContain('● ON');
    expect(formatInitLine('  cfo.ai Ari context   on · per-attempt reports', style)).toContain('\u001b[1;38;2;76;175;80m● ON');
    expect(createTerminalStyle({ isTTY: true, env: { NO_COLOR: '' } }).enabled).toBe(false);
  });
});
