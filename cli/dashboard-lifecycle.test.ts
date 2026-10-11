import { describe, expect, it, vi } from 'vitest';
import * as command from '../adapters/command.js';
import { openDashboardBrowser, waitForDashboard } from './dashboard-lifecycle.js';

describe('dashboard lifecycle', () => {
  it('uses the system URL opener without spawning a coding agent', async () => {
    const run = vi.spyOn(command, 'runCommand').mockResolvedValue({ stdout: '', stderr: '' });
    try {
      await openDashboardBrowser('http://127.0.0.1:1234/');
      expect(run.mock.calls[0]?.[1]).toContain('http://127.0.0.1:1234/');
      expect(run.mock.calls[0]?.[0]).toBe(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open');
    } finally { run.mockRestore(); }
  });
  it('keeps serving until Ctrl+C, then closes and removes its signal listeners', async () => {
    const close = vi.fn(async () => {});
    const before = process.listenerCount('SIGINT');
    const waiting = waitForDashboard({ server: {} as never, url: '', dataUrl: '', close });
    expect(close).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.emit('SIGINT');
    await waiting;
    expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
