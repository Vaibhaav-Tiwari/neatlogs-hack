import { runCommand } from '../adapters/command.js';
export async function openDashboardBrowser(url) {
    if (process.platform === 'darwin')
        await runCommand('open', [url]);
    else if (process.platform === 'win32')
        await runCommand('cmd', ['/c', 'start', '', url]);
    else
        await runCommand('xdg-open', [url]);
}
export async function waitForDashboard(dashboard) {
    await new Promise((resolve, reject) => {
        const stop = () => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            dashboard.close().then(resolve, reject);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}
//# sourceMappingURL=dashboard-lifecycle.js.map