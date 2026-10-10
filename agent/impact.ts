import type { TaskImpact } from '../schema/types.js';

export function capImpact(impact: TaskImpact): TaskImpact {
  const ranked = [...impact.nodes].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.id.localeCompare(b.id));
  const nodes = ranked.slice(0, 40);
  const weights = new Map(nodes.map((node) => [node.id, node.weight ?? 0]));
  const connected = impact.edges.filter((edge) => weights.has(edge.from) && weights.has(edge.to));
  connected.sort((a, b) => (weights.get(b.from)! + weights.get(b.to)!) - (weights.get(a.from)! + weights.get(a.to)!) ||
    `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`));
  const edges = connected.slice(0, 80);
  return { ...impact, nodes, edges, totals: { ...impact.totals, nodes: impact.nodes.length, edges: impact.edges.length }, truncated: impact.truncated || nodes.length < impact.nodes.length || edges.length < impact.edges.length };
}
