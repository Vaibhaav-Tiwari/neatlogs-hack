export type AoDaemonState = 'running' | 'stopped' | 'unknown';
export interface AoDaemonStatus {
    state: AoDaemonState;
    detail: string;
}
export declare function parseAoDaemonStatus(stdout: string): AoDaemonStatus;
export declare function readAoDaemonStatus(command: (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>, cwd?: string): Promise<AoDaemonStatus>;
