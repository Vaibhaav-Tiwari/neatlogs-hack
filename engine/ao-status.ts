export type AoDaemonState = 'running' | 'stopped' | 'unknown';

export interface AoDaemonStatus {
  state: AoDaemonState;
  detail: string;
}

export function parseAoDaemonStatus(stdout: string): AoDaemonStatus {
  try {
    const payload = JSON.parse(stdout) as { state?: unknown };
    if (payload.state === 'running') return { state: 'running', detail: 'AO daemon is running' };
    if (payload.state === 'stopped') return { state: 'stopped', detail: 'AO daemon is stopped' };
  } catch {
    // Older or incompatible AO output must not be mistaken for a live daemon.
  }
  return { state: 'unknown', detail: 'AO status did not report a running or stopped state' };
}

export async function readAoDaemonStatus(
  command: (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>,
  cwd?: string,
): Promise<AoDaemonStatus> {
  return parseAoDaemonStatus((await command('ao', ['status', '--json'], { cwd })).stdout);
}
