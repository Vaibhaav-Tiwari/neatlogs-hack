import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 10_000_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}

// A Git fetch exercises npm's Git packaging, not an already prepared tarball.
const source = process.argv[2] ?? 'github:Vaibhaav-Tiwari/neatlogs-hack#release';
const scratch = await mkdtemp(join(tmpdir(), 'tally-git-install-'));
const prefix = join(scratch, 'prefix');
const cwd = join(scratch, 'empty');
let server;
try {
  await mkdir(cwd);
  console.log(`Installing ${source} using ${run(npm, ['--version']).trim()}`);
  run(npm, ['install', '-g', source, '--prefix', prefix, '--cache', join(scratch, 'cache'), '--foreground-scripts', '--no-audit', '--no-fund'], { cwd });
  const cli = join(prefix, 'lib', 'node_modules', 'tally-agents', 'bin', 'tally.js');
  const windowsCli = join(prefix, 'node_modules', 'tally-agents', 'bin', 'tally.js');
  const installedCli = process.platform === 'win32' ? windowsCli : cli;
  const command = process.platform === 'win32' ? process.execPath : join(prefix, 'bin', 'tally');
  const commandArgs = process.platform === 'win32' ? [installedCli] : [];
  const manifest = JSON.parse(await readFile(join(dirname(dirname(installedCli)), 'package.json'), 'utf8'));
  assert.equal(manifest.scripts, undefined, 'release installs must not invoke Git build preparation');
  assert.equal(manifest.devDependencies, undefined, 'release needs no dev tools');
  const version = run(command, [...commandArgs, '--version'], { cwd }).trim();
  assert.match(version, /\d+\.\d+\.\d+/);
  console.log(`tally --version: ${version}`);
  assert.match(run(command, [...commandArgs, '--help'], { cwd }), /demo/);
  assert.match(run(command, [...commandArgs, 'demo'], { cwd }), /7 tasks, 9 attempts/);
  const provenance = JSON.parse(await readFile(join(dirname(dirname(installedCli)), 'release-source.json'), 'utf8'));
  assert.match(provenance.sourceCommit, /^[a-f\d]{40}$/);
  server = spawn(command, [...commandArgs, 'dashboard', '--port', '0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('dashboard startup timed out')), 15_000);
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`dashboard exited ${code}: ${output}`)); });
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/dashboard (http:\/\/\S+)/);
      if (match) { clearTimeout(timer); accept(match[1]); }
    });
    server.stderr.on('data', chunk => { output += chunk; });
  });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ledger/);
  for (const asset of ['app.js', 'code-graph.js', 'styles.css', 'runs/index.json', 'runs/latest/run.json', 'runs/latest/ledger.json']) {
    assert.equal((await fetch(new URL(asset, url))).status, 200, asset);
  }
  const state = JSON.parse(await readFile(resolve(cwd, '.tally/runs/latest/run.json'), 'utf8'));
  assert.equal(state.tasks.length, 7);
  console.log('Git install passed: version, help, seven-task demo and dashboard assets/run data from an empty directory.');
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await stopped;
  }
  await rm(scratch, { recursive: true, force: true });
}
