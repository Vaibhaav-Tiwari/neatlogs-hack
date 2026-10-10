import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { edgePath, graphLayout, graphNodes, shortPath } from './code-graph.js';
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
  it('groups large relations, keeps labels distinct and stays under one desktop screen', () => {
    const layout = graphLayout(graphNodes(run.tasks[2].impact), 1040);
    expect(layout.height).toBeLessThan(600);
    expect(layout.nodes.filter(n => n.kind === 'caller')).toHaveLength(3);
    expect(layout.summaries.some(item => item.text.includes('more callers'))).toBe(true);
    const labels = layout.nodes.map(node => shortPath(node.label, 30));
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('keeps six- and fifteen-node groups stable when only a hidden count changes', () => {
    for (const count of [6, 15]) {
      const nodes = Array.from({ length: count }, (_, i) => ({ id: `src/services/service_${i}/adapter.ts`, kind: i === 0 ? 'target' : 'caller', weight: count - i }));
      const a = graphLayout(nodes, 1040);
      const b = graphLayout([...nodes, { id: 'src/services/extra.ts', kind: 'caller', weight: 0 }], 1040);
      expect(a.nodes).toEqual(b.nodes);
      expect(a.height).toEqual(b.height);
      expect(a.summaries).not.toEqual(b.summaries);
    }
  });
  it('routes connections between node boundaries, using an outside rail on phones', () => {
    const from = { x: 16, y: 40, width: 300 };
    const to = { x: 350, y: 200, width: 300 };
    expect(edgePath(from, to, false)).toMatch(/^M316 65 C/);
    expect(edgePath(from, { ...to, x: 16 }, true)).toBe('M16 65 H8 V225 H16');
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
