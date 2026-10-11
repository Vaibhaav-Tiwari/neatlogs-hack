import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from './command.js';
import { sizingPaths } from './sizing-paths.js';
import { RepositorySizingAdapter } from './repository-sizing.js';
import { EntireSizingAdapter } from './entire.js';

describe('sizing path eligibility', () => {
  it('excludes tool-owned, build and gitignored files even when tracked', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tally-sizing-ignore-'));
    await runCommand('git', ['init', '-q'], { cwd: repoPath });
    writeFileSync(join(repoPath, '.gitignore'), 'generated.js\n');
    writeFileSync(join(repoPath, 'generated.js'), 'function makeSection() {}');
    writeFileSync(join(repoPath, 'main.js'), 'function makeSection() {}');
    await runCommand('git', ['add', '-f', '--', 'generated.js', 'main.js'], { cwd: repoPath });
    const candidates = ['main.js', 'generated.js', '.tally/runs/latest/run.json', '.entire/settings.json', '.claude/settings.json', '.codex/hooks.json', 'node_modules/pkg/index.js', 'build/main.js', 'dist/main.js'];
    expect(await sizingPaths(repoPath, candidates)).toEqual(['main.js']);
    const signals = await new RepositorySizingAdapter({ repoPath }).signalsFor({ taskId: 'T1', title: 'Fix makeSection', body: 'makeSection should return a section.' });
    expect(signals).toMatchObject({ filesTouched: 1, scope: { existingFiles: ['main.js'] } });
    const graph = new EntireSizingAdapter({ repoPath, runner: { async run(command, args) {
      if (command === 'git') return runCommand(command, args, { cwd: repoPath });
      if (args.includes('search')) return { stdout: JSON.stringify({ results: [
        { file_path: 'main.js', qualified_name: 'makeSection', score: 80 },
        { file_path: 'generated.js', qualified_name: 'makeSection', score: 90 },
      ] }) };
      if (args.includes('impact')) return { stdout: JSON.stringify({ callers: { total: 1, entries: [{ endpoint: { file_path: 'generated.js' }, depth: 1 }] } }) };
      return { stdout: '{}' };
    } } });
    const graphSignals = await graph.signalsFor({ taskId: 'T1', title: 'Fix makeSection', body: 'makeSection should return a section.' });
    expect(graphSignals).toMatchObject({ filesTouched: 1, dependents: 0, contextFiles: [] });
    expect(graphSignals?.impact?.nodes.map(node => node.id)).toEqual(['main.js']);
  });
});
