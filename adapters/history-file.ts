import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PriceHistory, type PriceHistorySnapshot } from '../agent/history.js';
import type { AttemptOutcome, PriceHistoryPort, PriceHistorySource, PriceHistoryWriterPort, PriceStats } from '../agent/ports.js';
import type { TaskSize } from '../schema/types.js';

export interface HistoryFileStore {
  read(path: string): Promise<string>;
  write(path: string, body: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export class NodeHistoryFileStore implements HistoryFileStore {
  async read(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async write(path: string, body: string): Promise<void> {
    await writeFile(path, body, 'utf8');
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}

export interface FilePriceHistoryOptions {
  path: string;
  store?: HistoryFileStore;
}

/**
 * File-backed history for pass rate and average cost per (task size, tier/model).
 * Missing or unreadable files start empty, so the agent's prior still works.
 */
export class FilePriceHistory implements PriceHistoryPort, PriceHistoryWriterPort {
  private readonly path: string;
  private readonly store: HistoryFileStore;
  private loaded: Promise<PriceHistory> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastLookupSource: PriceHistorySource = 'none';

  constructor(options: FilePriceHistoryOptions) {
    this.path = options.path;
    this.store = options.store ?? new NodeHistoryFileStore();
  }

  async lookup(size: TaskSize, tierOrModel: string): Promise<PriceStats | null> {
    const stats = await (await this.history()).lookup(size, tierOrModel);
    this.lastLookupSource = stats ? 'local' : 'none';
    return stats ? { ...stats, source: 'local' } : null;
  }

  sourceOfLastLookup(): PriceHistorySource {
    return this.lastLookupSource;
  }

  async record(outcome: AttemptOutcome): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const history = await this.history();
      await history.record(outcome);
      await this.persist(history.snapshot());
    });
    return this.writeQueue;
  }

  async snapshot(): Promise<PriceHistorySnapshot> {
    return (await this.history()).snapshot();
  }

  private async history(): Promise<PriceHistory> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<PriceHistory> {
    try {
      return new PriceHistory(JSON.parse(await this.store.read(this.path)) as PriceHistorySnapshot);
    } catch {
      return new PriceHistory();
    }
  }

  private async persist(snapshot: PriceHistorySnapshot): Promise<void> {
    await this.store.mkdir(dirname(this.path));
    const tmp = `${this.path}.tmp`;
    await this.store.write(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    await this.store.rename(tmp, this.path);
  }
}
