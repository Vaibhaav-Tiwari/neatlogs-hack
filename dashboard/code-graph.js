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
  const summaries = [];
  const headings = [];
  let next = 28;
  const groups = phone ? [['target'], ['caller'], ['coChange', 'test']] : [['caller'], ['target'], ['coChange', 'test']];
  groups.forEach((group, col) => {
    let y = phone ? next : 28;
    const x = phone ? 16 : 16 + col * (boxWidth + 34);
    for (const kind of group) {
      const all = nodes.filter((node) => node.kind === kind);
      if (!all.length) continue;
      const files = kind === 'target' ? all : all.slice(0, kind === 'caller' ? 3 : 2);
      const parts = files.map(node => node.id.split('/'));
      const prefix = [];
      while (parts.every(path => path.length > prefix.length + 1 && path[prefix.length] === parts[0][prefix.length])) prefix.push(parts[0][prefix.length]);
      const shared = files.length > 1 ? prefix.join('/') : '';
      headings.push({ x, y, width: boxWidth, text: `${kindLabel[kind]}${shared ? ` · ${shared}/` : ''}` });
      y += 24;
      files.forEach((node, row) => positioned.push({ ...node, label: shared ? node.id.slice(shared.length + 1) : node.id, x, y: y + row * 62, width: boxWidth }));
      y += files.length * 62;
      // Reserve the summary line even when the group has no hidden files.
      summaries.push({ x, y, text: all.length > files.length ? `+${all.length - files.length} more ${kind === 'coChange' ? 'co-change files' : `${kind.toLowerCase()}s`}` : '' });
      y += 28;
    }
    if (phone) next = y + 12;
  });
  return { nodes: positioned, headings, summaries, height: Math.max(108, ...summaries.map(item => item.y + 28)) };
}

export function edgePath(from, to, phone) {
  const y1 = from.y + 25, y2 = to.y + 25;
  if (phone || from.x === to.x) {
    const rail = Math.min(from.x, to.x) - 8;
    return `M${from.x} ${y1} H${rail} V${y2} H${to.x}`;
  }
  const rightward = from.x < to.x;
  const x1 = rightward ? from.x + from.width : from.x;
  const x2 = rightward ? to.x : to.x + to.width;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
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
  const annotations = svgNode('g', { class: 'graph-group-labels' });
  svg.append(edges, files, annotations);
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
    const positioned = graphLayout(nextNodes, width);
    nodes = positioned.nodes;
    svg.setAttribute('viewBox', `0 0 ${width} ${positioned.height}`);
    svg.setAttribute('height', positioned.height);
    const positions = new Map(positioned.nodes.map((node) => [node.id, node]));
    edges.replaceChildren();
    for (const edge of (currentTask.impact.edges ?? []).slice(0, 80)) {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      if (!from || !to) continue;
      edges.append(svgNode('path', { d: edgePath(from, to, width < 620), class: `graph-edge edge-${['calls','changesWith','tests'].includes(edge.kind) ? edge.kind : 'calls'}` }));
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
      group.querySelector('.graph-path').textContent = shortPath(node.label, Math.max(18, Math.floor((node.width - 20) / 7.4)));
    }
    annotations.replaceChildren(...positioned.headings.map(item => {
      const label = svgNode('text', { x: item.x, y: item.y - 5, class: 'graph-group-label' }, shortPath(item.text, Math.floor(item.width / 7.4)));
      label.append(svgNode('title', {}, item.text));
      return label;
    }), ...positioned.summaries.map(item => svgNode('text', { x: item.x, y: item.y, class: 'graph-group-label' }, item.text)));
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
    const limited = task.impact.truncated || (task.impact.nodes?.length ?? 0) > 40;
    const shown = nodes.length;
    details.querySelector('.graph-caption').textContent = `${totals.filesTouched ?? 0} target ${totals.filesTouched === 1 ? 'file' : 'files'}, ${totals.dependents ?? 0} ${totals.dependents === 1 ? 'dependent' : 'dependents'}, ${totals.testsPresent ? 'tests present' : 'no tests found'} → ${task.size ?? 'unsized'}.${limited || shown < (task.impact.nodes?.length ?? 0) ? ` Showing ${shown}${Number.isFinite(totals.nodes) ? ` of ${totals.nodes}` : ''} nodes; ${limited ? 'slice truncated' : 'relations grouped'}, totals cover the full graph.` : ''}`;
    details.querySelector('summary').textContent = `Code graph · ${task.taskId} · ${task.impact.totals?.filesTouched ?? 0} target ${task.impact.totals?.filesTouched === 1 ? 'file' : 'files'}`;
    const queryLine = details.querySelector('.graph-query');
    queryLine.textContent = `${task.impact.source === 'scripted' ? 'Sample graph' : task.impact.source === 'entire-graph' ? 'Entire code graph' : 'Code search'} · ${task.title}`;
    queryLine.title = task.impact.query ?? '';
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
    note.textContent = outside.length ? `Edited outside ${limited ? 'displayed slice (prediction truncated)' : 'predicted slice'}: ${outside.join(', ')}` : task.changedFiles ? `${edited.size} ${edited.size === 1 ? 'file' : 'files'} edited; all within the predicted slice.` : '';
    note.classList.toggle('outside', outside.length > 0);
  }
  details.addEventListener('toggle', () => update(currentTask, attempts));
  const observer = new ResizeObserver(() => update(currentTask, attempts));
  observer.observe(details);
  const mediaChanged = () => update(currentTask, attempts);
  printMedia.addEventListener('change', mediaChanged);
  return { element: details, update, dispose: () => { observer.disconnect(); printMedia.removeEventListener('change', mediaChanged); } };
}
