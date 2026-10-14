import type { TraceAttributes, TracePort, TraceSpan } from './ports.js';
export declare const noopTrace: TracePort;
export declare function traceDecision<T>(trace: TracePort | undefined, name: string, attributes: TraceAttributes, fn: (span: TraceSpan) => Promise<T>): Promise<T>;
