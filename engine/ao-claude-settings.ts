import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../adapters/command.js';
import { loadConfig } from './config.js';
import { claudeScripts, requireClaudeScriptConsent } from './harness.js';
import { contentHash } from './install-record.js';

const SETTINGS = '.claude/settings.local.json';
const INSTRUCTIONS = 'CLAUDE.local.md';
const BEGIN = '<!-- tally:worker-scripts -->';
const END = '<!-- /tally:worker-scripts -->';
type Command = (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function noSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlink in Claude worker setup: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function outside(path: string, worktree: string): boolean {
  const rel = relative(worktree, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || resolve(worktree, rel) !== path;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** AO runs postCreate before launching the harness. Use the root's trusted config. */
export function aoClaudeSetupCommand(configPath: string): string {
  const entry = fileURLToPath(new URL('../bin/tally-worker-settings.js', import.meta.url));
  // Source tests and the published dist/engine module both resolve the package bin/.
  const bin = entry.includes(`${sep}dist${sep}bin${sep}`) ? resolve(dirname(entry), '../../bin/tally-worker-settings.js') : entry;
  return `${quote(process.execPath)} ${quote(bin)} --config ${quote(resolve(configPath))}`;
}

export interface AoClaudeSettingsOptions {
  configPath: string;
  worktreePath?: string;
  scriptRoot?: string;
  command?: Command;
}

export interface AoClaudeSettingsResult {
  installed: boolean;
  settingsPath?: string;
  testScript?: string;
  setupScript?: string;
}

export async function installAoClaudeSettings(options: AoClaudeSettingsOptions): Promise<AoClaudeSettingsResult> {
  const configPath = resolve(options.configPath);
  const config = loadConfig(configPath);
  if (config.runner === 'direct' || !config.tiers.some(tier => tier.harness === 'claude-code')) return { installed: false };
  requireClaudeScriptConsent(config.claudeCode?.allow, config.test);
  const root = realpathSync(resolve(dirname(configPath), config.repo.path));
  const worktree = realpathSync(options.worktreePath ?? process.cwd());
  if (worktree === root) throw new Error('Claude worker settings must be installed in an AO worktree, not the project checkout.');
  const command = options.command ?? ((file, args, opts) => runCommand(file, args, opts));
  const common = async (cwd: string) => realpathSync((await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })).stdout.trim());
  const gitDir = await common(worktree);
  if (gitDir !== await common(root)) throw new Error('Claude worker checkout is not a worktree of the configured repository.');
  const tracked = (await command('git', ['ls-files', '--', SETTINGS, INSTRUCTIONS], { cwd: worktree })).stdout.trim();
  if (tracked) throw new Error(`Worker-local Claude files are tracked; remove them from the index before enabling Tally: ${tracked}`);
  const settingsPath = join(worktree, SETTINGS);
  const instructionsPath = join(worktree, INSTRUCTIONS);
  for (const path of [join(worktree, '.claude'), settingsPath, instructionsPath]) noSymlink(path);
  const existing: unknown = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  if (!record(existing) || existing.permissions !== undefined && !record(existing.permissions)) throw new Error('Invalid existing Claude local settings; preserve and repair them before retrying.');
  const permissions = record(existing.permissions) ? existing.permissions : {};
  if (permissions.deny !== undefined && (!Array.isArray(permissions.deny) || !permissions.deny.every(rule => typeof rule === 'string'))) throw new Error('Invalid existing Claude deny rules; no settings were overwritten.');
  const localText = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf8') : '';
  if (localText.includes(BEGIN) !== localText.includes(END)
    || localText.includes(BEGIN) && (localText.indexOf(END) < localText.indexOf(BEGIN) || localText.split(BEGIN).length !== 2 || localText.split(END).length !== 2)) {
    throw new Error('Incomplete Tally worker instructions; preserve and repair CLAUDE.local.md before retrying.');
  }
  const scriptRoot = resolve(options.scriptRoot ?? join(homedir(), '.tally', 'ao-worker-scripts'));
  // Do not place executable consent inside anything the worker is allowed to edit.
  let parent = scriptRoot;
  while (!existsSync(parent)) parent = dirname(parent);
  const realScriptRoot = resolve(realpathSync(parent), relative(parent, scriptRoot));
  if (!outside(realScriptRoot, worktree) || !/^[a-zA-Z0-9_./-]+$/.test(realScriptRoot)) throw new Error('Claude scripts need a directory outside the worker worktree without spaces or shell metacharacters.');
  const scriptDir = join(realScriptRoot, contentHash(`${root}\n${worktree}`).slice(0, 24));
  noSymlink(scriptDir);
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  const scripts = claudeScripts(config.test).map(script => ({ ...script, path: join(scriptDir, `${script.name}-${contentHash(script.contents)}.sh`) }));
  for (const script of scripts) {
    noSymlink(script.path);
    if (existsSync(script.path)) {
      if (readFileSync(script.path, 'utf8') !== script.contents) throw new Error(`Tally-owned script changed; refusing to trust it: ${script.path}`);
    } else writeFileSync(script.path, script.contents, { flag: 'wx', mode: 0o500 });
    chmodSync(script.path, 0o500);
  }
  const paths = new Map(scripts.map(script => [script.rule, script.path]));
  const allow = config.claudeCode!.allow.map(rule => paths.has(rule) ? `Bash(/bin/sh ${paths.get(rule)})` : rule);
  const deny = [...new Set([...(permissions.deny as string[] | undefined ?? []), 'Bash(git push *)', 'Bash(gh *)', 'WebFetch', 'WebSearch', 'Agent',
    `Edit(/${scriptDir}/**)`, `Write(/${scriptDir}/**)`, `Edit(/${settingsPath})`, `Write(/${settingsPath})`])];
  const next = { ...existing, permissions: { ...permissions, defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable', allow, deny } };
  const block = `${BEGIN}\n# Tally worker commands\nUse the exact approved scripts below instead of executing their raw test/setup commands.\n${scripts.map(script => `- ${script.name}: \`/bin/sh ${script.path}\``).join('\n')}\nDo not edit these scripts or local permission settings. Tally handles publishing; do not push or create PRs.\n${END}`;
  const instructions = localText.includes(BEGIN)
    ? localText.slice(0, localText.indexOf(BEGIN)) + block + localText.slice(localText.indexOf(END) + END.length)
    : `${localText}${localText && !localText.endsWith('\n') ? '\n' : ''}${block}\n`;
  // Git's repository-local excludes are shared by worktrees, but never committed.
  const exclude = join(gitDir, 'info', 'exclude');
  noSymlink(join(gitDir, 'info'));
  noSymlink(exclude);
  const oldExclude = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const missing = [ `/${SETTINGS}`, `/${INSTRUCTIONS}` ].filter(line => !oldExclude.split(/\r?\n/).includes(line));
  if (missing.length) {
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, `${oldExclude}${oldExclude && !oldExclude.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
  writeFileSync(instructionsPath, instructions, { mode: 0o600 });
  chmodSync(instructionsPath, 0o600);
  return { installed: true, settingsPath, testScript: scripts.find(script => script.name === 'test')!.path,
    ...(scripts.some(script => script.name === 'setup') ? { setupScript: scripts.find(script => script.name === 'setup')!.path } : {}) };
}
