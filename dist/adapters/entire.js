import { runCommand } from './command.js';
import { isAbsolute, relative, resolve } from 'node:path';
import { capImpact } from '../agent/impact.js';
import { RepositorySizingAdapter, issueIdentifiers, looksLikeTest } from './repository-sizing.js';
import { sizingPath, sizingPaths } from './sizing-paths.js';
const execFileAsync = runCommand;
export class ShellCommandRunner {
    async run(command, args, options = {}) {
        const { stdout } = await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 });
        return { stdout };
    }
}
function parseJson(stdout) {
    try {
        return JSON.parse(stdout);
    }
    catch {
        return null;
    }
}
function objects(value) {
    if (Array.isArray(value))
        return value.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return [];
    for (const key of ['results', 'matches', 'symbols']) {
        const list = value[key];
        if (Array.isArray(list))
            return objects(list);
    }
    return [value];
}
function stringField(value, names) {
    for (const name of names) {
        const found = value[name];
        if (typeof found === 'string' && found.trim() !== '')
            return found;
    }
    return null;
}
function countField(value, name) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return 0;
    const direct = value[name];
    if (typeof direct === 'number' && Number.isFinite(direct))
        return direct;
    if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
        const total = direct.total;
        if (typeof total === 'number' && Number.isFinite(total))
            return total;
    }
    return 0;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function entries(value, group) {
    return objects(record(record(value)[group] ?? null).entries ?? []);
}
export class EntireSizingAdapter {
    repoPath;
    runner;
    topSymbols;
    fallback;
    taskDetails = new Map();
    graphStatus = {
        status: 'missing',
        detail: 'Entire graph has not succeeded yet. Falling back to code search. Fix: rerun `tally init` and choose Entire.',
    };
    constructor(options) {
        this.repoPath = options.repoPath;
        this.runner = options.runner ?? new ShellCommandRunner();
        this.topSymbols = options.topSymbols ?? 3;
        this.fallback = options.fallback ?? new RepositorySizingAdapter({ repoPath: options.repoPath,
            listFiles: async () => (await this.runner.run('git', ['ls-files', '-z'], { cwd: this.repoPath })).stdout.split('\0'),
        });
    }
    async signalsFor(task) {
        const query = `${task.title}\n${task.body}`.trim();
        if (query === '')
            return null;
        try {
            const signals = await this.entireGraphSignals(query, task);
            const detail = signals?.source === 'entire-graph' ? null : 'No code symbols matched this task; sized by repository search.';
            this.taskDetails.set(task.taskId, detail);
            this.graphStatus = { status: 'ok', detail: [...this.taskDetails.values()].some(value => value !== null)
                    ? this.taskDetails.size === 1 ? detail : 'Graph search available; tasks without matching code symbols are sized by repository search.' : null };
            return signals;
        }
        catch (e) {
            this.graphStatus = {
                status: 'missing',
                detail: `Entire graph is unavailable (${e.message}). Falling back to code search. Fix: rerun \`tally init\` and choose Entire.`,
            };
            this.taskDetails.set(task.taskId, this.graphStatus.detail);
            return this.fallback.signalsFor(task);
        }
    }
    status() {
        return this.graphStatus;
    }
    detailFor(task) {
        return this.taskDetails.get(task.taskId) ?? null;
    }
    async entireGraphSignals(query, task) {
        await this.runner.run('entire', ['graph', 'index', '--repo', this.repoPath]);
        const search = await this.runner.run('entire', [
            'graph',
            'search',
            '--repo',
            this.repoPath,
            '--profile',
            'full',
            '--format',
            'json',
            '--query',
            query,
        ]);
        const searchResult = parseJson(search.stdout);
        if (searchResult === null)
            throw new Error('graph search returned invalid JSON');
        const rawHits = objects(searchResult).filter((hit) => hit.section !== 'related' &&
            (typeof hit.score !== 'number' || hit.score > 0) && stringField(hit, ['qualified_name', 'symbol', 'symbol_name', 'name']));
        const hitPath = (hit) => this.repoRelative(stringField(hit, ['file_path', 'file', 'path']) ?? '');
        const allowed = new Set(await sizingPaths(this.repoPath, rawHits.map(hitPath).filter((path) => path !== null)));
        const hits = rawHits.filter(hit => allowed.has(hitPath(hit) ?? ''));
        const evidence = await this.fallback.signalsFor(task) ?? await new RepositorySizingAdapter({
            repoPath: this.repoPath, listFiles: async () => [...allowed],
        }).signalsFor(task);
        const targets = new Set([...(evidence?.scope?.existingFiles ?? []), ...(evidence?.scope?.newFiles ?? [])]);
        if (!targets.size) {
            const terms = issueIdentifiers(query);
            for (const hit of hits) {
                const symbol = stringField(hit, ['qualified_name', 'symbol', 'symbol_name', 'name']);
                if (terms.some(term => symbol === term || symbol.endsWith(`.${term}`)))
                    targets.add(hitPath(hit));
            }
        }
        const contextFiles = [...new Set([...allowed, ...(evidence?.contextFiles ?? [])])].filter(path => !targets.has(path));
        const targetHits = hits.filter(hit => targets.has(hitPath(hit)));
        if (!targetHits.length)
            return evidence ? { ...evidence, contextFiles } : null;
        const connectedPaths = [];
        const excludedConnections = [];
        const files = new Set();
        const nodes = new Map();
        const edges = new Map();
        let callers = 0;
        let coChanges = 0;
        let truncated = false;
        const addNode = (path, kind, weight, symbol) => {
            const id = path ? this.repoRelative(path) : null;
            if (!id)
                return null;
            const previous = nodes.get(id);
            const priority = { target: 4, test: 3, caller: 2, coChange: 1 };
            const candidate = { id, kind, weight, ...(symbol ? { symbol } : {}) };
            if (!previous || priority[kind] > priority[previous.kind])
                nodes.set(id, candidate);
            else if (weight > (previous.weight ?? 0))
                nodes.set(id, { ...previous, weight });
            return id;
        };
        const addEdge = (from, to, kind) => {
            if (from !== to)
                edges.set(`${from}:${to}:${kind}`, { from, to, kind });
        };
        for (const path of targets) {
            files.add(path);
            addNode(path, looksLikeTest(path) ? 'test' : 'target', 100);
        }
        for (const [index, hit] of targetHits.entries()) {
            const hitFile = stringField(hit, ['file_path', 'file', 'path']);
            const symbol = stringField(hit, ['qualified_name', 'symbol', 'symbol_name', 'name']);
            const target = addNode(hitFile, hitFile && looksLikeTest(hitFile) ? 'test' : 'target', typeof hit.score === 'number' ? hit.score : 100, symbol);
            if (!target) {
                truncated = true;
                continue;
            }
            files.add(target);
            // Probe only issue targets; other hits are context, not scope evidence.
            if (index >= this.topSymbols) {
                truncated = true;
                continue;
            }
            const impact = parseJson((await this.runner.run('entire', ['graph', 'impact', '--repo', this.repoPath, '--symbol', symbol, '--format', 'json'])).stdout);
            callers += countField(impact, 'callers');
            coChanges += countField(impact, 'co_changes');
            for (const group of ['callers', 'co_changes']) {
                const connected = entries(impact, group);
                if (connected.length < countField(impact, group))
                    truncated = true;
                for (const entry of connected) {
                    const endpoint = record(entry.endpoint ?? entry);
                    const path = stringField(endpoint, ['file_path', 'file', 'path']);
                    if (path) {
                        const local = this.repoRelative(path);
                        if (local)
                            connectedPaths.push(local);
                        else
                            excludedConnections.push(path);
                    }
                    const test = path !== null && looksLikeTest(path);
                    if (group === 'callers' && entry.depth !== undefined && entry.depth !== 1 && !test) {
                        truncated = true;
                        continue;
                    }
                    const kind = test ? 'test' : group === 'callers' ? 'caller' : 'coChange';
                    const weight = typeof entry.weight === 'number' ? entry.weight : group === 'callers' ? 10 : 1;
                    const id = addNode(path, kind, weight, stringField(endpoint, ['qualified_name', 'name']) ?? undefined);
                    if (!id) {
                        truncated = true;
                        continue;
                    }
                    if (test)
                        addEdge(id, target, 'tests');
                    else if (group === 'callers')
                        addEdge(id, target, 'calls');
                    else
                        addEdge(target, id, 'changesWith');
                }
            }
        }
        const allowedConnections = new Set(await sizingPaths(this.repoPath, connectedPaths));
        const excludedDependents = excludedConnections.length + connectedPaths.filter(path => !allowedConnections.has(path)).length;
        for (const [id, node] of nodes)
            if (!targets.has(id) && !allowedConnections.has(id))
                nodes.delete(id);
        for (const [id, edge] of edges)
            if (!nodes.has(edge.from) || !nodes.has(edge.to))
                edges.delete(id);
        const totals = { filesTouched: files.size, dependents: Math.max(0, callers + coChanges - excludedDependents), testsPresent: evidence?.testsPresent === true || [...nodes.keys()].some(looksLikeTest), nodes: nodes.size, edges: edges.size };
        return {
            filesTouched: totals.filesTouched, dependents: totals.dependents, testsPresent: totals.testsPresent,
            source: 'entire-graph',
            ...(evidence?.scope ? { scope: evidence.scope } : {}),
            contextFiles,
            impact: capImpact({ source: 'entire-graph', query, nodes: [...nodes.values()], edges: [...edges.values()], totals, truncated }),
        };
    }
    repoRelative(path) {
        const normalized = (isAbsolute(path) ? relative(resolve(this.repoPath), path) : path).replaceAll('\\', '/').replace(/^\.\//, '');
        return sizingPath(normalized);
    }
}
//# sourceMappingURL=entire.js.map