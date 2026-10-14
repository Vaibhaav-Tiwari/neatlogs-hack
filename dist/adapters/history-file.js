import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PriceHistory } from '../agent/history.js';
export class NodeHistoryFileStore {
    async read(path) {
        return readFile(path, 'utf8');
    }
    async write(path, body) {
        await writeFile(path, body, 'utf8');
    }
    async rename(from, to) {
        await rename(from, to);
    }
    async mkdir(path) {
        await mkdir(path, { recursive: true });
    }
}
/**
 * File-backed history for pass rate and average cost per (task size, tier/model).
 * Missing or unreadable files start empty, so the agent's prior still works.
 */
export class FilePriceHistory {
    path;
    store;
    loaded = null;
    writeQueue = Promise.resolve();
    lastLookupSource = 'none';
    constructor(options) {
        this.path = options.path;
        this.store = options.store ?? new NodeHistoryFileStore();
    }
    async lookup(size, tier, model) {
        const stats = await (await this.history()).lookup(size, tier, model);
        this.lastLookupSource = stats ? 'local' : 'none';
        return stats ? { ...stats, source: 'local' } : null;
    }
    sourceOfLastLookup() {
        return this.lastLookupSource;
    }
    async record(outcome) {
        this.writeQueue = this.writeQueue.then(async () => {
            const history = await this.history();
            await history.record(outcome);
            await this.persist(history.snapshot());
        });
        return this.writeQueue;
    }
    async snapshot() {
        return (await this.history()).snapshot();
    }
    async history() {
        this.loaded ??= this.load();
        return this.loaded;
    }
    async load() {
        try {
            return new PriceHistory(JSON.parse(await this.store.read(this.path)));
        }
        catch {
            return new PriceHistory();
        }
    }
    async persist(snapshot) {
        await this.store.mkdir(dirname(this.path));
        const tmp = `${this.path}.tmp`;
        await this.store.write(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
        await this.store.rename(tmp, this.path);
    }
}
//# sourceMappingURL=history-file.js.map