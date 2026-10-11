import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CommandError } from './command.js';
import { execFile } from 'node:child_process';

export function sizingPath(value: string): string | null {
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = path.split('/');
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || parts.some(part => part === '..' ||
    /^(?:\.git|\.tally|\.entire|\.claude|\.codex|node_modules|dist|build|out|coverage|\.next|\.nuxt|target|__pycache__|\.venv|\.cache|\.turbo|\.pytest_cache)$/.test(part))) return null;
  return path;
}

export async function sizingPaths(repoPath: string, values: string[]): Promise<string[]> {
  const paths = [...new Set(values.map(sizingPath).filter((path): path is string => path !== null))];
  if (!existsSync(join(repoPath, '.git'))) return paths;
  const ignored = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += 200) {
    const batch = paths.slice(offset, offset + 200);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: repoPath, encoding: 'utf8' }, (error, output, stderr) => {
        if (error && error.code !== 1) reject(new CommandError('git check-ignore failed', error.code, output, stderr));
        else resolve(output);
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(`${batch.join('\0')}\0`);
    });
    stdout.split('\0').filter(Boolean).forEach(path => ignored.add(path));
  }
  return paths.filter(path => !ignored.has(path));
}
