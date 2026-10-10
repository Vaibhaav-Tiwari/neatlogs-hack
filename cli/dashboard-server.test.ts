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
    mkdirSync(join(runsDir, 'run-old'), { recursive: true });
    mkdirSync(join(runsDir, 'run-new'), { recursive: true });
    mkdirSync(dashboardDir, { recursive: true });
    writeFileSync(join(dashboardDir, 'index.html'), '<h1>Tally</h1>');
    writeFileSync(join(dashboardDir, 'app.js'), 'export const ok = true;');
    writeFileSync(join(runsDir, 'latest', 'run.json'), '{"runId":"run-test","tasks":[],"budget":{"spentNanos":0,"limitNanos":1}}');
    writeFileSync(join(runsDir, 'latest', 'ledger.json'), '[]');
    writeFileSync(join(runsDir, 'run-old', 'run.json'), '{"runId":"run-old","updatedAt":"2026-10-10T10:00:00.000Z","status":"finished","mode":"tally","repo":"acme/old"}');
    writeFileSync(join(runsDir, 'run-new', 'run.json'), '{"runId":"run-new","updatedAt":"2026-10-10T11:00:00.000Z","status":"running","mode":"baseline","repo":"acme/new"}');
    writeFileSync(join(dir, 'secret.txt'), 'nope');

    const dashboard = await startDashboardServer({ port: 0, dashboardDir, runsDir });
    try {
      expect(dashboard.dataUrl).toBe('/runs/latest/');
      expect(dashboard.url).toContain(encodeURIComponent('/runs/latest/'));
      await expect((await fetch(dashboard.url)).text()).resolves.toContain('Tally');
      await expect((await fetch(new URL('/runs/latest/run.json', dashboard.url))).json()).resolves.toMatchObject({ runId: 'run-test' });
      await expect((await fetch(new URL('/runs/index.json', dashboard.url))).json()).resolves.toEqual({
        runs: [
          { id: 'run-new', path: '/runs/run-new/', updatedAt: '2026-10-10T11:00:00.000Z', status: 'running', mode: 'baseline', repo: 'acme/new' },
          { id: 'run-old', path: '/runs/run-old/', updatedAt: '2026-10-10T10:00:00.000Z', status: 'finished', mode: 'tally', repo: 'acme/old' },
        ],
        experiments: [],
      });
      const experimentDir = join(runsDir, 'experiments', 'exp-test');
      mkdirSync(experimentDir, { recursive: true });
      writeFileSync(join(experimentDir, 'summary.json'), JSON.stringify({ real: false, repo: 'acme/new', status: 'running' }));
      const index = await (await fetch(new URL('/runs/index.json', dashboard.url))).json();
      expect(index.experiments).toMatchObject([{ id: 'exp-test', path: '/runs/experiments/exp-test/', real: false, status: 'running', repo: 'acme/new' }]);
      await expect((await fetch(new URL('/runs/experiments/exp-test/summary.json', dashboard.url))).json()).resolves.toMatchObject({ status: 'running' });
      expect((await fetch(new URL('/runs/', dashboard.url))).status).toBe(404);
      expect((await fetch(new URL('/runs/../secret.txt', dashboard.url))).status).toBe(404);
      expect((await fetch(new URL('/../secret.txt', dashboard.url))).status).toBe(404);
    } finally {
      await dashboard.close();
    }
  });
});
