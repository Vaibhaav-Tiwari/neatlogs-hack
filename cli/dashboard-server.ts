import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  dashboardDir?: string;
  runsDir?: string;
}

export interface DashboardServer {
  server: Server;
  url: string;
  dataUrl: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function inside(root: string, file: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(file);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${sep}`);
}

function fileFrom(root: string, path: string, index = false): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const stripped = decoded.replace(/^\/+/, '');
  const relative = stripped === '' ? '' : normalize(stripped);
  const file = resolve(root, index && relative === '' ? 'index.html' : relative);
  return inside(root, file) ? file : null;
}

function serveFile(root: string, path: string, index: boolean, status: (code: number) => void): string | null {
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

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<DashboardServer> {
  const host = options.host ?? '127.0.0.1';
  const dashboardDir = resolve(options.dashboardDir ?? 'dashboard');
  const runsDir = resolve(options.runsDir ?? '.tally/runs');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    let code = 200;
    const setStatus = (next: number) => {
      code = next;
    };
    const file =
      url.pathname === '/runs'
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
  await new Promise<void>((resolveListen, reject) => {
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
