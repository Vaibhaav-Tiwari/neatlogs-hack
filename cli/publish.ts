import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PublishOptions {
  out: string;
  runs?: string[];
  runsDir?: string;
  dashboardDir?: string;
}

export class PublishError extends Error {}

function dashboardAssets(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || /(?:fixture|testing|node_modules|^runs$|\.(?:test|spec)\.)/i.test(entry.name)) return [];
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new PublishError(`refusing symlinked dashboard asset: ${path}`);
    if (entry.isDirectory()) return dashboardAssets(root, path);
    return ['.html', '.js', '.css', '.woff', '.woff2', '.ttf', '.otf'].includes(extname(entry.name)) && path !== 'config.js' ? [path] : [];
  });
}

function scan(text: string, file: string): void {
  const patterns = [
    /(?:\/Users\/|\/home\/|\/root\/|[A-Z]:\\Users\\)/i,
    /-----BEGIN (?:\w+ )*PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
    /(?:^|\n)\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=/,
    /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|token)["']?\s*[:=]\s*["']?[^\s"',}\]]{4,}/i,
    /https?:\/\/[^\s/]+:[^\s/]+@/i,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw new PublishError(`refusing ${file}: possible secret, environment content or home-directory path`);
}

function readSafe(file: string): Buffer {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new PublishError(`refusing non-regular file: ${file}`);
  const data = readFileSync(file);
  scan(data.toString('utf8'), file);
  return data;
}

function scanJson(value: unknown, file: string): void {
  if (typeof value === 'string') {
    scan(value, file);
    if (value.includes('~/')) throw new PublishError(`refusing ${file}: home-directory path`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item) => scanJson(item, file)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:transcript|messages|conversation|environment|env|credentials|secrets?)$/i.test(key)) throw new PublishError(`refusing ${file}: private worker or environment content`);
      scanJson(item, file);
    }
  }
}

function isReal(run: Record<string, any>, ledger: Record<string, any>[]): boolean {
  const kind = run.dataKind ?? run.runKind ?? run.kind ?? run.costKind ?? run.sourceKind;
  return run.dryRun !== true && (kind === undefined || ['real', 'real-run', 'live'].includes(String(kind).toLowerCase()))
    && typeof run.repo === 'string' && !/^(?:acme|demo|sample|fixture)\//i.test(run.repo)
    && ledger.length > 0 && ledger.every((row) => ['list-price', 'ao-estimate'].includes(row.costSource));
}

/** Build in memory first: rejected data never leaves a partial publish directory. */
export function publishSite(options: PublishOptions): { files: { path: string; bytes: number }[]; totalBytes: number } {
  const source = resolve(options.runsDir ?? '.tally/runs');
  const out = resolve(options.out);
  if (out === source || out.startsWith(`${source}${sep}`) || source.startsWith(`${out}${sep}`)) throw new PublishError('output must be separate from the runs directory');
  if (existsSync(out)) throw new PublishError('output directory already exists; choose a new directory');
  const dashboard = options.dashboardDir ?? [fileURLToPath(new URL('../../dashboard/', import.meta.url)), fileURLToPath(new URL('../dashboard/', import.meta.url))].find((path) => existsSync(join(path, 'index.html')));
  if (!dashboard) throw new PublishError('dashboard assets not found');
  const ids = options.runs ?? readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'latest').map((entry) => entry.name);
  if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === 'latest')) throw new PublishError('runs must be recorded folder ids, not paths or latest');
  const files = new Map<string, Buffer>();
  const runs = [];
  for (const id of [...new Set(ids)]) {
    const folder = join(source, id);
    if (!existsSync(folder) || !lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw new PublishError(`invalid run folder: ${id}`);
    for (const name of ['run.json', 'ledger.json']) {
      const file = join(folder, name);
      if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new PublishError(`invalid run file: ${id}/${name}`);
    }
    let run, ledger;
    try {
      run = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8'));
      ledger = JSON.parse(readFileSync(join(folder, 'ledger.json'), 'utf8'));
    } catch { throw new PublishError(`invalid run files: ${id}`); }
    if (!run || !Array.isArray(run.tasks) || !run.budget || !Array.isArray(ledger) || ledger.some((row) => !row || (row.runId && row.runId !== run.runId))) throw new PublishError(`invalid run data: ${id}`);
    if (!options.runs && !isReal(run, ledger)) continue;
    scanJson(run, `${id}/run.json`);
    scanJson(ledger, `${id}/ledger.json`);
    // Only the public dashboard contract ships; extra worker files are never copied.
    if (readdirSync(folder).some((name) => /(?:\.env|transcript|credentials|secrets?|tokens?|session.*\.jsonl)/i.test(name))) throw new PublishError(`refusing ${id}: sensitive worker or environment file`);
    for (const name of ['run.json', 'ledger.json']) files.set(`runs/${id}/${name}`, readSafe(join(folder, name)));
    runs.push({ id, path: `./runs/${encodeURIComponent(id)}/`, updatedAt: run.updatedAt ?? run.startedAt, status: run.status, mode: run.mode, repo: run.repo, real: isReal(run, ledger) });
  }
  runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const initial = runs.find((run) => run.real) ?? runs[0];
  if (!initial) throw new PublishError('no real runs to publish');
  for (const asset of dashboardAssets(dashboard)) files.set(asset, readSafe(join(dashboard, asset)));
  const add = (path: string, text: string) => { scan(text, path); files.set(path, Buffer.from(text)); };
  add('config.js', `window.TALLY_DASHBOARD = ${JSON.stringify({ data: initial.path, runsIndex: './runs/index.json', runsRoot: './runs/', baseline: null, sample: null, intervalMs: 2000, aoProject: null }, null, 2)};\n`);
  add('runs/index.json', `${JSON.stringify({ runs: runs.map(({ real: _real, ...entry }) => entry) }, null, 2)}\n`);
  add('README.md', `# Tally static dashboard\n\nProduced with tally publish --out <dir>${options.runs ? ` --runs ${[...new Set(ids)].join(',')}` : ''}.\n\nSnapshot created ${new Date().toISOString()}. Includes ${runs.length} recorded runs.\nOnly dashboard assets, run.json and ledger.json are included.\nServe this directory with any static HTTP host, including under a sub-path.\nOpen index.html through that host; no Tally server or credentials are required.\nThis snapshot does not update from the original worker.\n`);
  mkdirSync(out, { recursive: true });
  for (const [path, data] of files) { mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), data); }
  const list = [...files].map(([path, data]) => ({ path, bytes: data.length })).sort((a, b) => a.path.localeCompare(b.path));
  return { files: list, totalBytes: list.reduce((sum, file) => sum + file.bytes, 0) };
}
