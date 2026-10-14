/**
 * The Tally mark in the terminal: four hand-drawn strokes with two eyes,
 * struck through by one orange slash, beside "Meet Tally".
 *
 * Everything is drawn with half-block characters, so one character cell holds
 * two square pixels. Strokes use the terminal's own foreground colour and
 * therefore read on light and dark backgrounds alike; only the slash is coloured.
 */
export type LogoColor = 'none' | '16' | '256' | 'truecolor';
export type LogoShow = 'animate' | 'static' | 'none';
export type LogoIntent = 'bare' | 'help' | 'init' | 'logo' | 'other';
export interface LogoPlan {
    show: LogoShow;
    color: LogoColor;
    /** True when this showing uses up the once-only first run. */
    markSeen: boolean;
}
export interface LogoContext {
    intent: LogoIntent;
    /** False when the command was asked to run without prompts or to print for a machine. */
    interactive: boolean;
    env: Record<string, string | undefined>;
    isTTY: boolean;
    columns: number;
    /** Terminal height in rows. */
    rows: number;
    /** Bits of colour the terminal reports: 1, 4, 8 or 24. */
    colorDepth: number;
    /** Whether the first-run animation has already played on this machine. */
    seen: boolean;
}
export declare const FULL_WIDTH: number;
export declare const FULL_ROWS: number;
export declare const COMPACT_WIDTH: number;
/** Milliseconds at which each part of the animation starts; `end` is its length. */
export declare const TIMELINE: {
    readonly stroke: 120;
    readonly eyes: 500;
    readonly blinkShut: 640;
    readonly blinkOpen: 720;
    readonly slash: 800;
    readonly text: 980;
    readonly end: 1280;
};
export declare const FRAME_MS = 40;
export interface LogoState {
    /** Pixels of each stroke drawn so far, from its top. */
    strokes: number[];
    eyes: boolean;
    /** True for the two frames in which the eyes are shut. */
    blink?: boolean;
    /** Columns of the slash drawn so far, from the left. */
    slash: number;
    /** 0 hidden, 1 arriving (dim, offset), 2 nearly there, 3 settled. */
    text: 0 | 1 | 2 | 3;
}
export declare const SETTLED: LogoState;
/** What is on screen `ms` into the animation. */
export declare function logoStateAt(ms: number): LogoState;
/** Visible width of a line, ignoring colour codes. */
export declare function visibleWidth(line: string): number;
/** The large mark with its text, as `FULL_ROWS` lines. */
export declare function logoFrame(state: LogoState, color: LogoColor): string[];
/** The small mark shown above the help text once the first run is over. */
export declare function compactLogo(color: LogoColor): string[];
/** Decides whether to animate, show the still mark, or stay silent. */
export declare function planLogo(context: LogoContext): LogoPlan;
export interface LogoTerminal {
    write: (text: string) => void;
    /** Resolves after `ms`. */
    sleep: (ms: number) => Promise<void>;
    /** Registers a handler for Ctrl+C and for termination, and returns a function that removes it. */
    onInterrupt: (handler: (exitCode: number) => void) => () => void;
    /** Ends the process after an interrupt. */
    exit: (code: number) => void;
}
/** Every frame of the animation, first to last. The last is the settled logo. */
export declare function logoFrames(color: LogoColor): string[][];
/**
 * Plays the animation in place. The cursor is hidden while it runs and is
 * restored when it ends, when it throws, on Ctrl+C and when the process is told to stop.
 */
export declare function playLogo(terminal: LogoTerminal, color: LogoColor): Promise<void>;
/** The still logo: large for `tally logo`, compact above the help text. */
export declare function staticLogo(intent: LogoIntent, color: LogoColor, columns: number): string;
export declare function logoMarkerPath(home?: string): string;
export declare const logoSeen: (path?: string) => boolean;
/** Records that the first-run animation has played. A home that cannot be written to is not an error. */
export declare function markLogoSeen(path?: string): void;
/** The real terminal, for the CLI entry point. */
export declare function processTerminal(): LogoTerminal;
/** Shows the logo for this invocation, if it should be shown at all. */
export declare function showLogo(context: LogoContext, terminal: LogoTerminal, markerPath?: string): Promise<LogoPlan>;
