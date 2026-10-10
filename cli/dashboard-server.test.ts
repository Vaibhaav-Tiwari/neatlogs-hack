import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startDashboardServer } from './dashboard-server.js';

describe('dashboard server', () => {
  it('serves dashboard files and run data without directory listing or traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tally-dashboard-'));
    const dashboardDir = join(dir, 'dashboard');
    const runsDir = join(dir, '.tally', 'runs');
    mkdirSync(join(runsDir, 'latest'), { recursive: true });
    mkdirSync(dashboardDir, { recursive: true });
    writeFileSync(join(dashboardDir, 'index.html'), '<h1>Tally</h1>');
    writeFileSync(join(dashboardDir, 'app.js'), 'export const ok = true;');
    writeFileSync(join(runsDir, 'latest', 'run.json'), '{"runId":"run-test","tasks":[],"budget":{"spentNanos":0,"limitNanos":1}}');
    writeFileSync(join(runsDir, 'latest', 'ledger.json'), '[]');
    writeFileSync(join(dir, 'secret.txt'), 'nope');

    const dashboard = await startDashboardServer({ port: 0, dashboardDir, runsDir });
    try {
      expect(dashboard.dataUrl).toBe('/runs/latest/');
      expect(dashboard.url).toContain(encodeURIComponent('/runs/latest/'));
      await expect((await fetch(dashboard.url)).text()).resolves.toContain('Tally');
      await expect((await fetch(new URL('/runs/latest/run.json', dashboard.url))).json()).resolves.toMatchObject({ runId: 'run-test' });
      expect((await fetch(new URL('/runs/', dashboard.url))).status).toBe(404);
      expect((await fetch(new URL('/runs/../secret.txt', dashboard.url))).status).toBe(404);
      expect((await fetch(new URL('/../secret.txt', dashboard.url))).status).toBe(404);
    } finally {
      await dashboard.close();
    }
  });
});
