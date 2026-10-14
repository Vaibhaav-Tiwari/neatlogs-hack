export type TerminalTone = 'brand' | 'success' | 'warning' | 'error' | 'muted' | 'bold';
export type DisplayStatus = 'connected' | 'ok' | 'off' | 'missing' | 'broken' | 'unavailable' | 'unverified' | 'error';
export interface TerminalStyleOptions {
    isTTY?: boolean;
    env?: Record<string, string | undefined>;
}
export interface TerminalStyle {
    enabled: boolean;
    paint(text: string, tone: TerminalTone): string;
    heading(text: string): string;
    status(status: DisplayStatus): string;
    divider(width?: number): string;
}
export declare function createTerminalStyle(options?: TerminalStyleOptions): TerminalStyle;
export declare function formatDoctorLine(line: {
    product: string;
    status: DisplayStatus;
    detail: string;
    fix: string | null;
}, style: TerminalStyle): string[];
export declare function formatInitLine(line: string, style: TerminalStyle): string;
export declare function formatInitPrompt(question: string, defaultValue: string, style: TerminalStyle): string;
