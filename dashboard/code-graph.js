const NS = 'http://www.w3.org/2000/svg';
const kinds = ['target', 'caller', 'coChange', 'test'];
const kindLabel = { target: 'Target', caller: 'Caller', coChange: 'Changes together', test: 'Test' };
export const shortPath = (path, max = 30) => path.length <= max ? path : `${path.slice(0, Math.floor((max - 3) / 2))}...${path.slice(-Math.ceil((max - 3) / 2))}`;
export function graphNodes(impact) {
  return [...new Map((impact?.nodes ?? []).filter((node) => typeof node.id === 'string' && kinds.includes(node.kind)).map((node) => [node.id, node])).values()]
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (b.weight ?? 0) - (a.weight ?? 0) || a.id.localeCompare(b.id)).slice(0, 40);
}

/** Fixed layers and sorted rows keep a slice still between polls. */
export function graphLayout(nodes, width) {
  const phone = width < 620;
  const boxWidth = phone ? width - 32 : Math.floor((width - 100) / 3);
  const positioned = [];
  let next = 28;
  const groups = phone ? [['target'], ['caller'], ['coChange', 'test']] : [['caller'], ['target'], ['coChange', 'test']];
  groups.forEach((group, col) => {
    const files = nodes.filter((node) => group.includes(node.kind));
    files.forEach((node, row) => positioned.push({ ...node, x: phone ? 16 : 16 + col * (boxWidth + 34), y: phone ? next + row * 68 : 28 + row * 68, width: boxWidth }));
    if (phone) next += files.length * 68 + (files.length ? 16 : 0);
  });
  return { nodes: positioned, height: Math.max(108, ...positioned.map((node) => node.y + 78)) };
}

function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createCodeGraph(task) {
  const details = document.createElement('details');
  details.className = 'code-graph';
  details.innerHTML = '<summary>Code impact</summary><div class="graph-paper"><p class="graph-caption"></p><p class="graph-query"></p><svg class="impact-graph" role="img"></svg><ol class="graph-attempts"></ol><p class="graph-outside"></p></div>';
  const svg = details.querySelector('svg');
  const edges = svgNode('g', { class: 'graph-edges' });
  const files = svgNode('g');
  svg.append(edges, files);
  const groups = new Map();
  let currentTask = task;
  let attempts = [];
  let layoutKey = '';
  let nodes = [];
  const printMedia = matchMedia('print');

  function layout() {
    const width = printMedia.matches ? 1040 : Math.max(280, Math.min(1040, details.getBoundingClientRect().width || 1040));
    const nextNodes = graphNodes(currentTask.impact);
    const key = JSON.stringify([Math.round(width), nextNodes, currentTask.impact.edges]);
    if (key === layoutKey) return;
    layoutKey = key;
    nodes = nextNodes;
    const positioned = graphLayout(nodes, width);
    svg.setAttribute('viewBox', `0 0 ${width} ${positioned.height}`);
    svg.setAttribute('height', positioned.height);
    const positions = new Map(positioned.nodes.map((node) => [node.id, node]));
    edges.replaceChildren();
    for (const edge of (currentTask.impact.edges ?? []).slice(0, 80)) {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      if (!from || !to) continue;
      const x1 = from.x + from.width / 2, y1 = from.y + 25;
      const x2 = to.x + to.width / 2, y2 = to.y + 25;
      edges.append(svgNode('path', { d: `M${x1} ${y1} C${x1} ${(y1+y2)/2} ${x2} ${(y1+y2)/2} ${x2} ${y2}`, class: `graph-edge edge-${['calls','changesWith','tests'].includes(edge.kind) ? edge.kind : 'calls'}` }));
    }
    for (const node of positioned.nodes) {
      let group = groups.get(node.id);
      if (!group) {
        group = svgNode('g', { tabindex: 0 });
        group.append(svgNode('title'), svgNode('rect', { height: 50 }), svgNode('text', { x: 10, y: 20, class: 'graph-path' }), svgNode('text', { x: 10, y: 38, class: 'graph-role' }));
        groups.set(node.id, group); files.append(group);
      }
      group.setAttribute('transform', `translate(${node.x} ${node.y})`);
      group.querySelector('rect').setAttribute('width', node.width);
      group.querySelector('title').textContent = `${node.id}${node.symbol ? ` (${node.symbol})` : ''}`;
      group.querySelector('.graph-path').textContent = shortPath(node.id, Math.max(18, Math.floor((node.width - 20) / 7.4)));
    }
    for (const [id, group] of groups) if (!positions.has(id)) { group.remove(); groups.delete(id); }
  }

  function update(task, rows) {
    currentTask = task; attempts = rows;
    layout();
    const edited = new Set(task.changedFiles ?? []);
    const last = attempts[attempts.length - 1];
    const active = task.status === 'running' && last?.endedAt === null;
    for (const node of nodes) {
      const group = groups.get(node.id);
      const state = edited.has(node.id) ? 'edited' : active && node.kind === 'target' ? 'in progress' : last?.result === 'stopped' && node.kind === 'target' ? 'stopped' : 'predicted';
      group.setAttribute('class', `graph-node kind-${node.kind} ${state.replaceAll(' ', '-')}`);
      group.setAttribute('aria-label', `${node.id}, ${kindLabel[node.kind]}, ${state}`);
      group.querySelector('.graph-role').textContent = `${kindLabel[node.kind]} · ${state === 'edited' ? 'edited [x]' : state}`;
    }
    const totals = task.impact.totals ?? {};
    const limited = task.impact.truncated || (task.impact.nodes?.length ?? 0) > nodes.length;
    details.querySelector('.graph-caption').textContent = `${totals.filesTouched ?? 0} target ${totals.filesTouched === 1 ? 'file' : 'files'}, ${totals.dependents ?? 0} dependents, ${totals.testsPresent ? 'tests present' : 'no tests found'} → ${task.size ?? 'unsized'}.${limited ? ` Showing ${nodes.length}${Number.isFinite(totals.nodes) ? ` of ${totals.nodes}` : ''} nodes; slice truncated, totals cover the full graph.` : ''}`;
    details.querySelector('summary').textContent = `Code impact · ${task.taskId}`;
    details.querySelector('.graph-query').textContent = `${task.impact.source === 'scripted' ? 'Sample graph' : task.impact.source === 'entire-graph' ? 'Entire code graph' : 'Code search'}${task.impact.query ? ` · ${task.impact.query}` : ''}`;
    svg.setAttribute('aria-label', `Code impact for ${task.title}`);
    const timeline = details.querySelector('.graph-attempts');
    const signature = JSON.stringify(attempts.map((row) => [row.attempt, row.tier, row.result, row.endedAt]));
    if (timeline.dataset.signature !== signature) {
      timeline.dataset.signature = signature;
      timeline.replaceChildren(...attempts.map((row) => {
        const item = document.createElement('li');
        item.className = row.result === 'stopped' ? 'graph-stop' : '';
        item.textContent = `Attempt ${row.attempt} · ${row.tier} · ${row.endedAt === null ? 'running' : row.result}${row.attempt > 1 ? ' · continues this slice' : ''}`;
        return item;
      }));
    }
    const predicted = new Set((task.impact.nodes ?? []).map((node) => node.id));
    const outside = [...edited].filter((path) => !predicted.has(path)).sort();
    const note = details.querySelector('.graph-outside');
    note.textContent = outside.length ? `Edited outside ${limited ? 'displayed slice (prediction truncated)' : 'predicted slice'}: ${outside.join(', ')}` : task.changedFiles ? `${edited.size} files edited; all within the predicted slice.` : '';
    note.classList.toggle('outside', outside.length > 0);
  }
  details.addEventListener('toggle', () => update(currentTask, attempts));
  const observer = new ResizeObserver(() => update(currentTask, attempts));
  observer.observe(details);
  const mediaChanged = () => update(currentTask, attempts);
  printMedia.addEventListener('change', mediaChanged);
  return { element: details, update, dispose: () => { observer.disconnect(); printMedia.removeEventListener('change', mediaChanged); } };
}
