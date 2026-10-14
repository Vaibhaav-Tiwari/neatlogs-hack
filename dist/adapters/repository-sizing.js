import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { runCommand } from './command.js';
import { capImpact } from '../agent/impact.js';
import { sizingPath, sizingPaths } from './sizing-paths.js';
export function looksLikeTest(path) {
    return /(^|\/)(__tests__|tests?|spec)(\/)|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_.*\.py$|_test\.go$/i.test(path);
}
function safePath(value) {
    return sizingPath(value);
}
function clauses(text) {
    return text.split(/[;\n]|[.!?](?=\s|$)/).filter(Boolean);
}
function paths(text) {
    return [...new Set([...text.matchAll(/(?<![\w./:\\-])(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w-]{0,9}\b/g)]
            .map(match => safePath(match[0])).filter((path) => path !== null))];
}
export function issueIdentifiers(text) {
    const quoted = [...text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)].map(match => match[1] ?? match[2] ?? match[3]);
    const named = text.match(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?=\s*\()|\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b/g) ?? [];
    return [...new Set([...quoted.filter(value => !/\s/.test(value)), ...named].flatMap(value => value.match(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\b/g) ?? []))]
        .filter(value => value.length >= 3 && !/^(true|false|null|README|test|tests)$/.test(value) && !/\.(?:js|ts|py|md|css|html|json)$/.test(value)).slice(0, 16);
}
function fileStem(path) {
    return basename(path).replace(/\.[^.]+$/, '').replace(/^(test_|spec_)/, '').replace(/[._-](test|spec)$/, '');
}
/** Local target evidence only: dependencies and runtime correctness require stronger evidence. */
export class RepositorySizingAdapter {
    options;
    constructor(options) {
        this.options = options;
    }
    async signalsFor(task) {
        const query = `${task.title}\n${task.body}`.trim();
        if (!query)
            return null;
        let tracked;
        try {
            tracked = this.options.listFiles ? await this.options.listFiles()
                : (await runCommand('git', ['ls-files', '-z'], { cwd: this.options.repoPath, maxBuffer: 4 * 1024 * 1024 })).stdout.split('\0');
        }
        catch {
            return null;
        }
        tracked = (await sizingPaths(this.options.repoPath, tracked)).sort();
        const known = new Set(tracked);
        const parts = clauses(query);
        const createOnly = /\b(?:do not|don['’]t)\s+(?:change|edit|modify|touch)\s+(?:any\s+)?existing files?\b/i.test(query);
        const existing = new Set();
        const created = new Set();
        const context = new Set();
        const excluded = new Set();
        for (const part of parts)
            if (/\b(?:do not|don['’]t|never)\s+(?:change|edit|modify|touch)\b|\bfrozen\b/i.test(part)) {
                const directories = part.match(/(?:[\w.-]+\/)+(?=[\s,;`"'()]|$)/g) ?? [];
                tracked.filter(path => directories.some(directory => path.startsWith(directory))).forEach(path => excluded.add(path));
            }
        const named = paths(query);
        for (const name of named) {
            const mentions = parts.filter(part => paths(part).includes(name));
            const prohibited = mentions.some(part => /\b(?:do not|don['’]t|never)\s+(?:change|edit|modify|touch)\b|\bfrozen\b/i.test(part));
            const matches = known.has(name) ? [name] : tracked.filter(path => !name.includes('/') && basename(path) === name);
            // Dotted API/module names are identifier evidence, not new filenames.
            if (!matches.length && !name.includes('/') && !/\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cpp|h|css|html|sh|md|txt|json|jsonl|ya?ml|toml|xml|sql|csv|svg|png|jpg|ini|conf)$/i.test(name))
                continue;
            if (prohibited) {
                matches.forEach(path => { excluded.add(path); context.add(path); });
                continue;
            }
            if (matches.length) {
                const contextOnly = mentions.every(part => /\b(using|defined in|described|following|loads?|read|refer(?:ence)?|pattern|example)\b/i.test(part)
                    && !/\b(fix|edit|modify|update|change|remove|extend)\b/i.test(part));
                if (createOnly || contextOnly)
                    matches.forEach(path => context.add(path));
                if (!createOnly && !contextOnly)
                    matches.filter(path => !excluded.has(path)).forEach(path => existing.add(path));
            }
            else if (mentions.some(part => /\b(create|add|write|new|implement)\b/i.test(part))
                || (createOnly && /\b(create|add|write)\b/i.test(query)))
                created.add(name);
        }
        // A named test file is evidence for its same-stem source module, not the whole repo.
        if (!createOnly)
            for (const target of [...existing].filter(looksLikeTest)) {
                tracked.filter(path => !looksLikeTest(path) && fileStem(path) === fileStem(target)
                    && path.slice(path.lastIndexOf('.')) === target.slice(target.lastIndexOf('.')) && !excluded.has(path))
                    .forEach(path => existing.add(path));
            }
        let truncated = false;
        // Search identifier boundaries, not generic issue words; never follow tracked symlinks.
        const pinnedSource = [...existing, ...created].some(path => !looksLikeTest(path));
        const terms = createOnly || pinnedSource ? [] : issueIdentifiers(query);
        const patterns = terms.map(term => new RegExp(`(^|[^A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`));
        const definitions = terms.map(term => new RegExp(`\\b(?:def|class|function|interface|type|struct|fn|const|let|var)\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
        const references = new Set();
        const declarations = new Set();
        const root = await realpath(this.options.repoPath).catch(() => resolve(this.options.repoPath));
        let bytes = 0;
        let searched = 0;
        const maxFiles = this.options.maxFiles ?? 1000;
        const maxFileBytes = this.options.maxFileBytes ?? 128 * 1024;
        const maxBytes = this.options.maxBytes ?? 8 * 1024 * 1024;
        if (patterns.length)
            for (const path of tracked) {
                if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cpp|h|css|html|sh)$/i.test(path) || excluded.has(path))
                    continue;
                if (searched >= maxFiles || bytes >= maxBytes) {
                    truncated = true;
                    break;
                }
                searched += 1;
                try {
                    const absolute = resolve(root, path);
                    const stat = await lstat(absolute);
                    if (!stat.isFile())
                        continue;
                    const actual = await realpath(absolute);
                    const local = relative(root, actual);
                    if (local.startsWith('..') || isAbsolute(local))
                        continue;
                    if (stat.size > maxFileBytes || bytes + stat.size > maxBytes) {
                        truncated = true;
                        continue;
                    }
                    const content = await readFile(actual, 'utf8');
                    bytes += stat.size;
                    if (!content.includes('\0')) {
                        if (patterns.some(pattern => pattern.test(content)))
                            references.add(path);
                        if (definitions.some(pattern => pattern.test(content)))
                            declarations.add(path);
                    }
                }
                catch {
                    truncated = true;
                }
            }
        // Prefer owners of identifiers to every file that merely references them.
        for (const path of declarations)
            existing.add(path);
        const allowed = new Set(await sizingPaths(this.options.repoPath, [...existing, ...created]));
        for (const path of existing)
            if (!allowed.has(path))
                existing.delete(path);
        for (const path of created)
            if (!allowed.has(path))
                created.delete(path);
        const targets = [...allowed].sort();
        if (!targets.length)
            return null;
        const testsPresent = tracked.some(path => looksLikeTest(path) && (existing.has(path) || targets.some(target => {
            const stem = fileStem(target);
            return fileStem(path) === stem || (dirname(path) === dirname(target) && basename(path).includes(stem));
        })));
        const totals = { filesTouched: targets.length, dependents: 0, testsPresent, nodes: targets.length, edges: 0 };
        return {
            filesTouched: targets.length, dependents: 0, testsPresent, source: 'code-search',
            contextFiles: [...new Set([...context, ...references])].filter(path => !existing.has(path)).sort(),
            scope: { existingFiles: [...existing].sort(), newFiles: [...created].sort(), createOnly,
                namedTargets: targets.filter(path => named.some(name => path === name || basename(path) === name)).length, truncated },
            impact: capImpact({ source: 'code-search', query, nodes: targets.map(id => ({ id, kind: 'target', weight: 1 })), edges: [], totals, truncated }),
        };
    }
}
//# sourceMappingURL=repository-sizing.js.map