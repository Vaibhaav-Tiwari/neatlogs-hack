import type { DashboardServer } from './dashboard-server.js';
export declare function openDashboardBrowser(url: string): Promise<void>;
export declare function waitForDashboard(dashboard: DashboardServer): Promise<void>;
