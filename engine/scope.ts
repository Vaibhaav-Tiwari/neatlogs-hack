import { basename } from 'node:path';
import type { BacklogTask } from './backlog.js';

// Source and test files stay unrestricted; this guard highlights infrastructure changes.
export function outOfScopeFiles(task: BacklogTask, files: string[]): string[] {
  const text = `${task.title}\n${task.body}`.toLowerCase();
  return files.filter((file) => {
    const name = basename(file).toLowerCase();
    if (text.includes(file.toLowerCase()) || text.includes(name)) return false;
    const ci = /^(\.github\/|\.gitlab|\.circleci\/)|(^|\/)jenkinsfile$/i.test(file);
    const deployment = /(^|\/)(vercel\.json|netlify\.toml|dockerfile[^/]*|docker-compose[^/]*|fly\.toml)|^(deploy|deployment|terraform|\.vercel)\//i.test(file);
    const rootConfig = !file.includes('/') && (/\.(json|ya?ml|toml|lock|config\.[cm]?[jt]s)$/i.test(file) || /^(\.[^/]+|makefile|justfile)$/i.test(file));
    if (ci && /\b(ci|workflow|continuous integration)\b/.test(text)) return false;
    if (deployment && /\b(deploy\w*|vercel|netlify|docker|terraform)\b/.test(text)) return false;
    return ci || deployment || rootConfig;
  });
}
