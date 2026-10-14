import { type Server } from 'node:http';
export interface DashboardServerOptions {
    port?: number;
    host?: string;
    dashboardDir?: string;
    runsDir?: string;
}
export interface DashboardServer {
    server: Server;
    url: string;
    dataUrl: string;
    close(): Promise<void>;
}
export declare function startDashboardServer(options?: DashboardServerOptions): Promise<DashboardServer>;
