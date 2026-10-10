import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { loadFileBacklog } from '../dist/engine/backlog.js';

test('all seven demo graph slices survive the backlog loader with consistent totals', () => {
  const config = parse(readFileSync(new URL('./tally.yaml', import.meta.url), 'utf8'));
  const tasks = loadFileBacklog(config, new URL('./tally.yaml', import.meta.url).pathname);
  assert.equal(tasks.length, 7);
  for (const task of tasks) {
    const impact = task.impact;
    assert.equal(impact.source, 'scripted');
    assert.ok(impact.nodes.length > 0);
    assert.equal(impact.totals.nodes, impact.nodes.length);
    assert.equal(impact.totals.edges, impact.edges.length);
    assert.equal(impact.totals.filesTouched, impact.nodes.filter(n => n.kind === 'target').length);
    assert.equal(impact.totals.dependents, impact.nodes.filter(n => n.kind === 'caller').length);
    assert.equal(impact.totals.testsPresent, impact.nodes.some(n => n.kind === 'test'));
    const ids = new Set(impact.nodes.map(n => n.id));
    for (const edge of impact.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to));
    for (const id of ids) assert.ok(!id.startsWith('/') && !id.includes('..'));
  }
});

test('the escalated cache repair scripts a change outside its predicted slice', () => {
  const backlog = parse(readFileSync(new URL('./sample-backlog.yaml', import.meta.url), 'utf8'));
  const task = backlog.tasks.find(t => t.id === 'T5');
  const predicted = new Set(task.impact.nodes.map(n => n.id));
  const attempts = task.scriptedOutcome.attempts;
  assert.equal(attempts[0].result, 'stopped');
  assert.equal(attempts[1].result, 'passed');
  assert.ok(attempts[1].changedFiles.some(path => !predicted.has(path)));
});
