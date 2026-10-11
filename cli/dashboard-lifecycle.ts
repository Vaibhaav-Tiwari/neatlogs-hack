import { runCommand } from '../adapters/command.js';
import type { DashboardServer } from './dashboard-server.js';

export async function openDashboardBrowser(url: string): Promise<void> {
  if (process.platform === 'darwin') await runCommand('open', [url]);
  else if (process.platform === 'win32') await runCommand('cmd', ['/c', 'start', '', url]);
  else await runCommand('xdg-open', [url]);
}

export async function waitForDashboard(dashboard: DashboardServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      dashboard.close().then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
