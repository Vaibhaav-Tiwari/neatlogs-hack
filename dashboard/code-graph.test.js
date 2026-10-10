import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphLayout, graphNodes, shortPath } from './code-graph.js';
import { frameAt } from './replay-core.js';
const run = JSON.parse(readFileSync(new URL('./graph-fixture/run.json', import.meta.url)));
const ledger = JSON.parse(readFileSync(new URL('./graph-fixture/ledger.json', import.meta.url)));

describe('task code graphs', () => {
  for (const width of [354, 1040]) {
    it(`keeps nodes inside the picture with no overlaps at ${width}px`, () => {
      for (const task of run.tasks) {
        const nodes = graphNodes(task.impact);
        const layout = graphLayout(nodes, width);
        for (const node of layout.nodes) {
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.x + node.width).toBeLessThanOrEqual(width);
          expect(node.y + 50).toBeLessThan(layout.height);
          for (const other of layout.nodes.filter((other) => other.id !== node.id)) {
            expect(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + 50 <= other.y || other.y + 50 <= node.y).toBe(true);
          }
        }
      }
    });
  }
  it('orders the same slice identically regardless of input order and caps it at 40', () => {
    const impact = run.tasks[2].impact;
    expect(graphNodes({ ...impact, nodes: [...impact.nodes].reverse() })).toEqual(graphNodes(impact));
    expect(graphNodes(impact)).toHaveLength(40);
    expect(shortPath('src/a/very/long/path/to/a/filename.py', 20)).toHaveLength(20);
  });
  it('replays running, stopped and escalated attempts without leaking final changed files', () => {
    const early = frameAt(run, ledger, 0.2);
    expect(early.run.tasks[1].changedFiles).toBeUndefined();
    const stopped = frameAt(run, ledger, 0.425);
    expect(stopped.ledger.find((row) => row.taskId === 'G2').result).toBe('stopped');
    const resumed = frameAt(run, ledger, 0.6);
    expect(resumed.ledger.filter((row) => row.taskId === 'G2').map((row) => row.result)).toEqual(['stopped', 'running']);
    expect(resumed.run.tasks[1].changedFiles).toBeUndefined();
    expect(frameAt(run, ledger, 1).run.tasks[1].changedFiles).toContain('src/database/migrations/charge_key_unique.py');
  });
});
