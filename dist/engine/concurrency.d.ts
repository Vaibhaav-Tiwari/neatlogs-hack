export declare class SerialQueue {
    private tail;
    run<T>(operation: () => Promise<T>): Promise<T>;
}
export declare function runPool<T>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<void>): Promise<void>;
/** Reservations and ledger costs are exchanged synchronously, never across an await. */
export declare class Reservations {
    private readonly available;
    private held;
    private waiters;
    constructor(available: () => number);
    remaining(owner?: string): number;
    reserve(owner: string, amount: number): boolean;
    settle(owner: string, cost: number): void;
    release(owner: string): void;
    waiting(owner?: string): Promise<void> | null;
    private notify;
}
