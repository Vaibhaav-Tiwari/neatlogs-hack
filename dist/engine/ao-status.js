export function parseAoDaemonStatus(stdout) {
    try {
        const payload = JSON.parse(stdout);
        if (payload.state === 'ready' && payload.health === 'ok' && payload.ready === 'ready') {
            return { state: 'running', detail: 'AO daemon is healthy and ready' };
        }
        if (payload.state === 'running')
            return { state: 'running', detail: 'AO daemon is running' };
        if (payload.state === 'stopped')
            return { state: 'stopped', detail: 'AO daemon is stopped' };
    }
    catch {
        // Older or incompatible AO output must not be mistaken for a live daemon.
    }
    return { state: 'unknown', detail: 'AO status did not report a running or stopped state' };
}
export async function readAoDaemonStatus(command, cwd) {
    return parseAoDaemonStatus((await command('ao', ['status', '--json'], { cwd })).stdout);
}
//# sourceMappingURL=ao-status.js.map