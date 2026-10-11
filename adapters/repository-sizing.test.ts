import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositorySizingAdapter } from './repository-sizing.js';
import { sizeFromSignals } from '../agent/sizer.js';

function fixture(files: Record<string, string>, options = {}) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tally-sizing-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoPath, path)), { recursive: true });
    writeFileSync(join(repoPath, path), content);
  }
  const adapter = new RepositorySizingAdapter({ repoPath, listFiles: async () => Object.keys(files), ...options });
  return { repoPath, adapter };
}
const task = (body: string, title = 'Requested change') => ({ taskId: 'T1', title, body });

describe('RepositorySizingAdapter', () => {
  it('counts one explicitly new file without inflating it by read-only context paths', async () => {
    const f = fixture({ 'index.html': '', 'js/core/registry.js': 'ChipViz.register()', 'css/site.css': '' });
    const input = task('Add README.md describing index.html and ChipViz.register() as defined in js/core/registry.js, and python3 -m http.server. Do not change any existing file. Keep it under 80 lines.');
    const signals = await f.adapter.signalsFor(input);
    expect(signals).toMatchObject({ filesTouched: 1, source: 'code-search', testsPresent: false,
      scope: { newFiles: ['README.md'], existingFiles: [], namedTargets: 1, createOnly: true } });
    expect(signals?.impact?.nodes).toEqual([{ id: 'README.md', kind: 'target', weight: 1 }]);
    const estimate = sizeFromSignals(input, signals);
    expect(estimate.size).toBe('small');
    expect(estimate.confidence).toBeGreaterThan(0.6);
    expect(estimate.summary).toContain('from the issue text and a search of the repository');
    expect(estimate.summary).toContain('create: README.md');
  });

  it('counts distinct new and existing targets, excludes frozen paths and reference-only names', async () => {
    const f = fixture({ 'src/old.ts': '', 'src/frozen.ts': '', 'docs/plan.md': '', 'css/tokens.css': '' });
    const signals = await f.adapter.signalsFor(task('Edit src/old.ts. Create src/a.ts and src/b.ts. Use variables defined in css/tokens.css; following docs/plan.md. Do not edit src/frozen.ts.'));
    expect(signals?.filesTouched).toBe(3);
    expect(signals?.scope?.newFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(signals?.impact?.nodes.map(node => node.id)).toEqual(['src/a.ts', 'src/b.ts', 'src/old.ts']);
    expect(signals?.impact?.edges).toEqual([]);
    expect(sizeFromSignals(task(''), signals).size).toBe('medium');
  });

  it('resolves basenames and notes nearby tests without counting unrelated tests', async () => {
    const f = fixture({ 'src/replay.py': 'def read_snapshot(): pass', 'tests/test_replay.py': '', 'tests/test_other.py': '' });
    const signals = await f.adapter.signalsFor(task('Fix replay.py to reject invalid inputs.'));
    expect(signals).toMatchObject({ filesTouched: 1, testsPresent: true, scope: { existingFiles: ['src/replay.py'] } });
    const absent = fixture({ 'src/replay.py': '', 'tests/test_other.py': '' });
    expect((await absent.adapter.signalsFor(task('Fix replay.py.')))?.testsPresent).toBe(false);
  });

  it('resolves quoted identifiers with a bounded native search, not generic prose or substring matches', async () => {
    const f = fixture({ 'src/a.ts': 'function renderWidget() {}', 'src/b.ts': 'function renderWidgetExtra() {}', 'src/c.ts': 'const expected = true;' });
    const signals = await f.adapter.signalsFor(task('`renderWidget` should reject invalid input.'));
    expect(signals?.scope?.existingFiles).toEqual(['src/a.ts']);
    expect(await f.adapter.signalsFor(task('Expected the page to be nicer.'))).toBeNull();
  });

  it('prefers identifier definitions over unrelated callers', async () => {
    const f = fixture({ 'src/a.ts': 'function renderWidget() {}', 'src/b.ts': 'renderWidget();' });
    expect((await f.adapter.signalsFor(task('Fix `renderWidget` to reject invalid input.')))?.scope?.existingFiles).toEqual(['src/a.ts']);
  });

  it('uses a named test to infer only its same-stem source module', async () => {
    const f = fixture({ 'src/replay.py': '', 'tests/test_replay.py': '', 'src/replay.ts': '', 'data/replay.jsonl': '', 'src/unrelated.py': '' });
    const signals = await f.adapter.signalsFor(task('Add regression coverage in tests/test_replay.py.'));
    expect(signals?.scope?.existingFiles).toEqual(['src/replay.py', 'tests/test_replay.py']);
    expect(signals?.testsPresent).toBe(true);
    expect(signals?.impact?.edges).toEqual([]);
  });

  it('marks a truncated search and reduces confidence rather than treating partial evidence as complete', async () => {
    const f = fixture({ 'a.ts': 'renderWidget()', 'b.ts': 'renderWidget()' }, { maxFiles: 1 });
    const input = task('`renderWidget` should reject invalid input.');
    const bounded = await f.adapter.signalsFor(input);
    const full = await new RepositorySizingAdapter({ repoPath: f.repoPath, listFiles: async () => ['a.ts', 'b.ts'] }).signalsFor(input);
    expect(bounded?.scope?.truncated).toBe(true);
    expect(bounded?.impact?.truncated).toBe(true);
    expect(sizeFromSignals(input, bounded).confidence).toBeLessThan(sizeFromSignals(input, full).confidence);
  });

  it('never follows symlinks or reads outside the repo, and ignores absolute paths and URLs', async () => {
    const f = fixture({ 'src/real.ts': 'const local = 1;' });
    const outside = mkdtempSync(join(tmpdir(), 'tally-sizing-outside-'));
    writeFileSync(join(outside, 'private.ts'), 'renderWidget()');
    symlinkSync(join(outside, 'private.ts'), join(f.repoPath, 'src/link.ts'));
    const adapter = new RepositorySizingAdapter({ repoPath: f.repoPath, listFiles: async () => ['src/link.ts', '../private.ts', '/outside.ts', '.git/secret.ts'] });
    expect(await adapter.signalsFor(task('`renderWidget` should work.'))).toBeNull();
    expect(await f.adapter.signalsFor(task('Create /outside/private.ts; visit https://example.com/file.ts.'))).toBeNull();
  });

  it('uses git tracked files without requiring rg or any integration CLI', async () => {
    const f = fixture({ 'src/code.ts': '', 'src/untracked.ts': '' });
    execFileSync('git', ['init', '-q'], { cwd: f.repoPath });
    execFileSync('git', ['add', 'src/code.ts'], { cwd: f.repoPath });
    const signals = await new RepositorySizingAdapter({ repoPath: f.repoPath }).signalsFor(task('Fix src/code.ts.'));
    expect(signals?.scope?.existingFiles).toEqual(['src/code.ts']);
    expect(await new RepositorySizingAdapter({ repoPath: f.repoPath }).signalsFor(task('Fix src/untracked.ts.'))).toBeNull();
  });

  it('keeps the size boundaries independent of repository or task identities', async () => {
    for (const [count, expected] of [[2, 'small'], [3, 'medium'], [7, 'medium'], [8, 'large']] as const) {
      const f = fixture({});
      const input = task(`Create ${Array.from({ length: count }, (_, i) => `src/f${i}.ts`).join(', ')}.`);
      expect(sizeFromSignals(input, await f.adapter.signalsFor(input)).size).toBe(expected);
    }
  });
});
