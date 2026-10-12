import { describe, expect, it } from 'vitest';
import { FilePriceHistory, type HistoryFileStore } from './history-file.js';

class MemoryStore implements HistoryFileStore {
  files = new Map<string, string>();
  renames: Array<{ from: string; to: string }> = [];
  mkdirs: string[] = [];

  async read(path: string): Promise<string> {
    const body = this.files.get(path);
    if (body === undefined) throw new Error('missing');
    return body;
  }

  async write(path: string, body: string): Promise<void> {
    this.files.set(path, body);
  }

  async rename(from: string, to: string): Promise<void> {
    const body = this.files.get(from);
    if (body === undefined) throw new Error('missing tmp');
    this.files.delete(from);
    this.files.set(to, body);
    this.renames.push({ from, to });
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirs.push(path);
  }
}

describe('FilePriceHistory', () => {
  it('keeps model cells separate across restarts and excludes old tier aggregates from model lookups', async () => {
    const store = new MemoryStore();
    const path = '/tmp/tally/history.json';
    store.files.set(path, JSON.stringify({ version: 1, cells: { 'small:cheap': { attempts: 6, passes: 6, totalCostNanos: 6 } } }));
    const history = new FilePriceHistory({ path, store });
    expect(await history.lookup('small', 'cheap', 'codex')).toBeNull();
    await history.record({ size: 'small', tier: 'cheap', model: 'codex', result: 'passed', costNanos: 100 });
    await history.record({ size: 'small', tier: 'cheap', model: 'claude', result: 'passed', costNanos: 900 });
    const restored = new FilePriceHistory({ path, store });
    expect(await restored.lookup('small', 'cheap', 'codex')).toMatchObject({ attempts: 1, avgCostNanos: 100, source: 'local' });
    expect(await restored.lookup('small', 'cheap', 'claude')).toMatchObject({ attempts: 1, avgCostNanos: 900 });
    expect(await restored.lookup('small', 'cheap', 'new-model')).toBeNull();
  });
  it('starts empty when the file is missing', async () => {
    const history = new FilePriceHistory({ path: '/tmp/tally/history.json', store: new MemoryStore() });
    await expect(history.lookup('small', 'model-a')).resolves.toBeNull();
  });

  it('persists pass rate and average cost per size and tier/model string', async () => {
    const store = new MemoryStore();
    const history = new FilePriceHistory({ path: '/tmp/tally/history.json', store });
    await history.record({ size: 'small', tier: 'model-a', result: 'passed', costNanos: 100 });
    await history.record({ size: 'small', tier: 'model-a', result: 'failed', costNanos: 300 });
    await history.record({ size: 'small', tier: 'model-b', result: 'passed', costNanos: 900 });
    expect(await history.lookup('small', 'model-a')).toEqual({ attempts: 2, passRate: 0.5, avgCostNanos: 200, source: 'local', successfulCostsNanos: [100] });
    expect(await history.lookup('small', 'model-b')).toEqual({ attempts: 1, passRate: 1, avgCostNanos: 900, source: 'local', successfulCostsNanos: [900] });
    expect(JSON.parse(store.files.get('/tmp/tally/history.json')!)).toMatchObject({
      version: 1,
      cells: {
        'small:model-a': { attempts: 2, passes: 1, totalCostNanos: 400 },
        'small:model-b': { attempts: 1, passes: 1, totalCostNanos: 900 },
      },
    });
    expect(new Set(store.mkdirs)).toEqual(new Set(['/tmp/tally']));
    expect(store.renames.at(-1)).toEqual({ from: '/tmp/tally/history.json.tmp', to: '/tmp/tally/history.json' });
  });

  it('loads an existing snapshot', async () => {
    const store = new MemoryStore();
    store.files.set(
      '/tmp/tally/history.json',
      JSON.stringify({ version: 1, cells: { 'medium:silver': { attempts: 4, passes: 3, totalCostNanos: 1000 } } }),
    );
    const history = new FilePriceHistory({ path: '/tmp/tally/history.json', store });
    expect(await history.lookup('medium', 'silver')).toEqual({ attempts: 4, passRate: 0.75, avgCostNanos: 250, source: 'local' });
  });

  it('starts empty when the file is corrupt', async () => {
    const store = new MemoryStore();
    store.files.set('/tmp/tally/history.json', 'not json');
    const history = new FilePriceHistory({ path: '/tmp/tally/history.json', store });
    await expect(history.lookup('large', 'gold')).resolves.toBeNull();
  });

  it('does not record errored attempts', async () => {
    const history = new FilePriceHistory({ path: '/tmp/tally/history.json', store: new MemoryStore() });
    await history.record({ size: 'large', tier: 'gold', result: 'error', costNanos: 900 });
    await expect(history.lookup('large', 'gold')).resolves.toBeNull();
  });
});
