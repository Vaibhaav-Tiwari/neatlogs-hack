import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { main, VERSION, versionLines } from './main.js';

it('reports the same version as the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(VERSION).toBe(manifest.version);
});

it('prints plain and verbose version provenance for releases and source checkouts', async () => {
  const io = { stdout: (line: string) => output.push(line), stderr: () => {} };
  const output: string[] = [];

  expect(await main(['--version'], io)).toBe(0);
  expect(output).toEqual([VERSION]);

  output.length = 0;
  expect(await main(['-v', '--verbose'], io)).toBe(0);
  expect(output).toEqual([VERSION, 'source: development checkout']);

  output.length = 0;
  expect(versionLines(true, mkdtempSync(join(tmpdir(), 'tally-version-')))).toEqual([
    VERSION,
    'source: development checkout',
  ]);

  const releaseRoot = mkdtempSync(join(tmpdir(), 'tally-version-'));
  writeFileSync(join(releaseRoot, 'release-source.json'), JSON.stringify({
    repository: 'Vaibhaav-Tiwari/neatlogs-hack',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  }));
  expect(versionLines(true, releaseRoot)).toEqual([
    VERSION,
    'source: 0123456789abcdef0123456789abcdef01234567 (Vaibhaav-Tiwari/neatlogs-hack)',
  ]);
});
