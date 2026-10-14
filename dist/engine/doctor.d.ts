import { checkCfoaiConnection } from '../adapters/cfoai.js';
export type DoctorStatus = 'connected' | 'missing' | 'broken' | 'off' | 'unverified' | 'unavailable';
export interface DoctorLine {
    product: string;
    status: DoctorStatus;
    detail: string;
    fix: string | null;
}
export declare function doctorHasFailures(lines: DoctorLine[]): boolean;
export type DoctorRunner = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export interface DoctorOptions {
    runner?: DoctorRunner;
    env?: Record<string, string>;
    cfoaiCheck?: typeof checkCfoaiConnection;
    configPath?: string;
}
export declare function runDoctor(options?: DoctorOptions): Promise<DoctorLine[]>;
