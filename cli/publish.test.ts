import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishSite } from './publish.js';
import { main } from './main.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tally-publish-'));
  const runsDir = join(root, 'source');
  mkdirSync(runsDir);
  const add = (id: string, dryRun = false, extra = {}) => {
    const folder = join(runsDir, id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'run.json'), JSON.stringify({ runId: id, repo: 'owner/product', dryRun, tasks: [], budget: {}, updatedAt: `2026-10-${id.endsWith('2') ? '11' : '10'}T00:00:00Z`, ...extra }));
    writeFileSync(join(folder, 'ledger.json'), JSON.stringify([{ runId: id, costSource: dryRun ? 'simulated' : 'list-price' }]));
    return folder;
  };
  return { root, runsDir, out: join(root, 'site'), add };
}

describe('static publish', () => {
  it('exports only real runs by default, newest first, using relative paths', () => {
    const f = fixture();
    f.add('real-1'); f.add('real-2'); f.add('dry', true); f.add('fixture', false, { repo: 'acme/payments-service' });
    const result = publishSite(f);
    const index = JSON.parse(readFileSync(join(f.out, 'runs/index.json'), 'utf8'));
    expect(index.runs.map((run: { id: string }) => run.id)).toEqual(['real-2', 'real-1']);
    expect(index.runs[0].path).toBe('./runs/real-2/');
    expect(readFileSync(join(f.out, 'config.js'), 'utf8')).toContain('./runs/real-2/');
    expect(result.totalBytes).toBe(result.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(existsSync(join(f.out, 'runs/dry'))).toBe(false);
  });

  it('allows explicitly selected simulated runs without silently adding other runs', () => {
    const f = fixture(); f.add('real'); f.add('dry', true);
    publishSite({ ...f, runs: ['dry'] });
    expect(existsSync(join(f.out, 'runs/dry/run.json'))).toBe(true);
    expect(existsSync(join(f.out, 'runs/real'))).toBe(false);
  });

  it('includes every local HTML and JS import, including newly added modules, and excludes fixtures', () => {
    const f = fixture(); f.add('real');
    const dashboardDir = join(f.root, 'dashboard');
    cpSync(new URL('../dashboard/', import.meta.url), dashboardDir, { recursive: true });
    writeFileSync(join(dashboardDir, 'extra-module.js'), 'export const extra = true;');
    writeFileSync(join(dashboardDir, 'app.js'), `${readFileSync(join(dashboardDir, 'app.js'), 'utf8')}\nimport './extra-module.js';`);
    mkdirSync(join(dashboardDir, 'graph-fixture'), { recursive: true });
    writeFileSync(join(dashboardDir, 'graph-fixture/index.html'), 'private fixture');
    const result = publishSite({ ...f, dashboardDir });
    expect(result.files.some((file) => file.path.includes('fixture'))).toBe(false);
    expect(result.files.some((file) => file.path.includes('.test.'))).toBe(false);
    const queue = ['index.html', 'app.js'];
    const seen = new Set<string>();
    while (queue.length) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const file = join(f.out, path);
      expect(existsSync(file), `missing imported asset ${path}`).toBe(true);
      const text = readFileSync(file, 'utf8');
      const matches = path.endsWith('.html') ? text.matchAll(/(?:src|href)=["']([^"']+)["']/g) : text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g);
      for (const match of matches) {
        const target = match[1]!;
        if (/^(?:data:|https?:|#)/.test(target)) continue;
        const imported = resolve(dirname(file), target);
        expect(existsSync(imported), `missing import ${target} from ${path}`).toBe(true);
        if (imported.endsWith('.js')) queue.push(imported.slice(f.out.length + 1));
      }
    }
    expect(seen.has('extra-module.js')).toBe(true);
  });

  for (const text of ['sk-12345678901234567890', '/Users/person/private', 'API_KEY=private-value', 'access_token: private-value', 'Bearer private-value']) {
    it(`rejects sensitive content before writing output (${text.split(':')[0]})`, () => {
      const f = fixture(); f.add('real', false, { detail: text });
      expect(() => publishSite(f)).toThrow(/refusing/);
      expect(existsSync(f.out)).toBe(false);
    });
  }

  it('refuses worker transcripts, path traversal, and existing output directories', () => {
    const f = fixture(); const dir = f.add('real');
    writeFileSync(join(dir, 'worker-transcript.jsonl'), '{}');
    expect(() => publishSite(f)).toThrow(/sensitive worker/);
    expect(() => publishSite({ ...f, runs: ['../source'] })).toThrow(/folder ids/);
    mkdirSync(f.out);
    expect(() => publishSite(f)).toThrow(/already exists/);
  });

  it('refuses embedded transcripts and escaped home paths', () => {
    for (const extra of [{ messages: [{ role: 'assistant', content: 'worker output' }] }, { detail: 'C:\\Users\\person\\private' }]) {
      const f = fixture(); f.add('real', false, extra);
      expect(() => publishSite(f)).toThrow(/refusing/);
      expect(existsSync(f.out)).toBe(false);
    }
  });

  it('requires --out and returns a useful CLI error', async () => {
    const errors: string[] = [];
    expect(await main(['publish'], { stdout: () => {}, stderr: (line) => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain('--out');
  });
});
