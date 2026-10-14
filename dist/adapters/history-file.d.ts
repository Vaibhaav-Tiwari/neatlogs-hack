import { type PriceHistorySnapshot } from '../agent/history.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistorySource, PriceHistoryWriterPort, PriceStats } from '../agent/ports.js';
import type { TaskSize } from '../schema/types.js';
export interface HistoryFileStore {
    read(path: string): Promise<string>;
    write(path: string, body: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}
export declare class NodeHistoryFileStore implements HistoryFileStore {
    read(path: string): Promise<string>;
    write(path: string, body: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}
export interface FilePriceHistoryOptions {
    path: string;
    store?: HistoryFileStore;
}
/**
 * File-backed history for pass rate and average cost per (task size, tier/model).
 * Missing or unreadable files start empty, so the agent's prior still works.
 */
export declare class FilePriceHistory implements PriceHistoryPort, PriceHistoryWriterPort {
    private readonly path;
    private readonly store;
    private loaded;
    private writeQueue;
    private lastLookupSource;
    constructor(options: FilePriceHistoryOptions);
    lookup(size: TaskSize, tier: string, model?: string): Promise<PriceStats | null>;
    sourceOfLastLookup(): PriceHistorySource;
    record(outcome: AttemptOutcome): Promise<void>;
    snapshot(): Promise<PriceHistorySnapshot>;
    private history;
    private load;
    private persist;
}
