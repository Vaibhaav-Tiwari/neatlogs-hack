import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { source: { type: 'string', default: 'origin/main' }, out: { type: 'string' }, push: { type: 'boolean', default: false } } });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const exec = (command, args, cwd = root) => execFileSync(command, args, {
  cwd, encoding: 'utf8', maxBuffer: 10_000_000,
  env: { ...process.env, npm_config_global: 'false' },
});
const sourceCommit = exec('git', ['rev-parse', `${values.source}^{commit}`]).trim();
if (values.push) exec('git', ['merge-base', '--is-ancestor', sourceCommit, 'origin/main']);
const scratch = await mkdtemp(join(tmpdir(), 'tally-release-build-'));
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'tally-release-'));
// Refuse to replace an existing tree; release output must start empty.
if (values.out) { await mkdir(dirname(out), { recursive: true }); await mkdir(out); }
try {
  const source = join(scratch, 'source');
  await mkdir(source);
  const archive = join(scratch, 'source.tar');
  await writeFile(archive, execFileSync('git', ['archive', sourceCommit], { cwd: root, maxBuffer: 20_000_000 }));
  exec('tar', ['-xf', archive, '-C', source]);
  exec(npm, ['ci', '--ignore-scripts', '--include=dev', '--global=false'], source);
  exec(npm, ['run', 'build', '--global=false'], source);
  const packed = JSON.parse(exec(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], source))[0];
  exec('tar', ['-xf', join(scratch, packed.filename), '-C', out, '--strip-components=1']);
  const manifestPath = join(out, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // npm triggers Git preparation even for a script named "build". Consumers need neither scripts nor dev tools.
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.files = [...(manifest.files ?? []), 'release-source.json'];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, 'release-source.json'), `${JSON.stringify({ repository: 'Vaibhaav-Tiwari/neatlogs-hack', sourceCommit }, null, 2)}\n`);
  exec('git', ['init', '--initial-branch=release', out]);
  // A maintainer's global ignore may exclude dist; the allowlisted package tree must be complete.
  exec('git', ['add', '--force', '--all'], out);
  exec('git', ['-c', 'user.name=Tally Release', '-c', 'user.email=release@users.noreply.github.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `Build Tally from ${sourceCommit}`], out);
  if (values.push) {
    exec('git', ['fetch', out, 'HEAD']);
    exec('git', ['push', '--force', 'origin', 'FETCH_HEAD:refs/heads/release']);
  }
  console.log(`Release tree: ${out}\nSource commit: ${sourceCommit}${values.push ? '\nUpdated origin/release' : ''}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
