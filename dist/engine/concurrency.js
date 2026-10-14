export class SerialQueue {
    tail = Promise.resolve();
    run(operation) {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => { });
        return result;
    }
}
export async function runPool(items, concurrency, run) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length)
                return;
            await run(items[index], index);
        }
    }));
}
/** Reservations and ledger costs are exchanged synchronously, never across an await. */
export class Reservations {
    available;
    held = new Map();
    waiters = [];
    constructor(available) {
        this.available = available;
    }
    remaining(owner) {
        return this.available() - [...this.held].reduce((sum, [key, amount]) => sum + (key === owner ? 0 : amount), 0);
    }
    reserve(owner, amount) {
        if (amount > this.remaining(owner))
            return false;
        this.held.set(owner, amount);
        return true;
    }
    settle(owner, cost) {
        if (this.held.has(owner))
            this.held.set(owner, Math.max(0, this.held.get(owner) - cost));
        this.notify();
    }
    release(owner) {
        this.held.delete(owner);
        this.notify();
    }
    waiting(owner) {
        if (![...this.held.keys()].some(key => key !== owner))
            return null;
        return new Promise(resolve => this.waiters.push(resolve));
    }
    notify() {
        for (const resolve of this.waiters.splice(0))
            resolve();
    }
}
//# sourceMappingURL=concurrency.js.map