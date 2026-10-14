import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};
function inside(root, file) {
    const resolvedRoot = resolve(root);
    const resolvedFile = resolve(file);
    return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${sep}`);
}
function fileFrom(root, path, index = false) {
    let decoded;
    try {
        decoded = decodeURIComponent(path);
    }
    catch {
        return null;
    }
    const stripped = decoded.replace(/^\/+/, '');
    const relative = stripped === '' ? '' : normalize(stripped);
    const file = resolve(root, index && relative === '' ? 'index.html' : relative);
    return inside(root, file) ? file : null;
}
function serveFile(root, path, index, status) {
    const file = fileFrom(root, path, index);
    if (!file || !existsSync(file)) {
        status(404);
        return null;
    }
    const stat = statSync(file);
    if (!stat.isFile()) {
        status(404);
        return null;
    }
    return file;
}
function runIndex(runsDir) {
    if (!existsSync(runsDir))
        return { runs: [], experiments: [] };
    const runs = readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'latest')
        .map((entry) => {
        const runDir = join(runsDir, entry.name);
        const runStatePath = join(runDir, 'run.json');
        if (!inside(runsDir, runStatePath) || !existsSync(runStatePath))
            return null;
        try {
            const run = JSON.parse(readFileSync(runStatePath, 'utf8'));
            const stat = statSync(runStatePath);
            return {
                id: entry.name,
                path: `/runs/${encodeURIComponent(entry.name)}/`,
                updatedAt: typeof run.updatedAt === 'string' ? run.updatedAt : stat.mtime.toISOString(),
                status: typeof run.status === 'string' ? run.status : null,
                mode: typeof run.mode === 'string' ? run.mode : null,
                repo: typeof run.repo === 'string' ? run.repo : null,
            };
        }
        catch {
            return null;
        }
    })
        .filter((entry) => entry !== null)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    const experimentRoot = join(runsDir, 'experiments');
    const experiments = !existsSync(experimentRoot) ? [] : readdirSync(experimentRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
        const path = join(experimentRoot, entry.name, 'summary.json');
        try {
            const summary = JSON.parse(readFileSync(path, 'utf8'));
            if (typeof summary.real !== 'boolean')
                return [];
            return [{ id: entry.name, path: `/runs/experiments/${encodeURIComponent(entry.name)}/`,
                    updatedAt: statSync(path).mtime.toISOString(), repo: typeof summary.repo === 'string' ? summary.repo : null,
                    real: summary.real, status: typeof summary.status === 'string' ? summary.status : null }];
        }
        catch {
            return [];
        }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { runs, experiments };
}
function defaultDashboardDir() {
    const candidates = [
        resolve('dashboard'),
        fileURLToPath(new URL('../dashboard/', import.meta.url)),
        fileURLToPath(new URL('../../dashboard/', import.meta.url)),
    ];
    return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? candidates[0];
}
export async function startDashboardServer(options = {}) {
    const host = options.host ?? '127.0.0.1';
    const dashboardDir = options.dashboardDir ? resolve(options.dashboardDir) : defaultDashboardDir();
    const runsDir = resolve(options.runsDir ?? '.tally/runs');
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${host}`);
        let code = 200;
        const setStatus = (next) => {
            code = next;
        };
        if (url.pathname === '/runs/index.json') {
            response.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
            response.end(`${JSON.stringify(runIndex(runsDir), null, 2)}\n`);
            return;
        }
        const file = url.pathname === '/runs'
            ? null
            : url.pathname.startsWith('/runs/')
                ? serveFile(runsDir, url.pathname.slice('/runs/'.length), false, setStatus)
                : serveFile(dashboardDir, url.pathname === '/' ? '' : url.pathname, true, setStatus);
        if (!file) {
            response.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(code === 404 ? 'not found\n' : 'error\n');
            return;
        }
        response.writeHead(200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
        });
        createReadStream(file).pipe(response);
    });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 5177, host, () => {
            server.off('error', reject);
            resolveListen();
        });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : options.port ?? 5177;
    const dataUrl = '/runs/latest/';
    const url = `http://${host}:${port}/?data=${encodeURIComponent(dataUrl)}`;
    return {
        server,
        url,
        dataUrl,
        close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
    };
}
//# sourceMappingURL=dashboard-server.js.map