import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

const protectedRunsDir = resolve(process.cwd(), '.tally/runs');

function fingerprint(path: string): string {
  const hash = createHash('sha256');

  function visit(current: string): void {
    if (!existsSync(current)) return;
    const stat = statSync(current);
    const name = relative(path, current) || '.';
    if (stat.isDirectory()) {
      hash.update(`dir:${name}\n`);
      for (const entry of readdirSync(current).sort()) visit(join(current, entry));
      return;
    }
    if (stat.isFile()) {
      hash.update(`file:${name}:${stat.size}:`);
      hash.update(readFileSync(current));
      hash.update('\n');
    }
  }

  visit(path);
  return hash.digest('hex');
}

let beforeFingerprint = '';

beforeAll(() => {
  beforeFingerprint = fingerprint(protectedRunsDir);
});

afterAll(() => {
  const afterFingerprint = fingerprint(protectedRunsDir);
  if (afterFingerprint !== beforeFingerprint) {
    throw new Error('Tests must not create, modify, or mirror data into workspace .tally/runs. Use a temp outputDir and latestRunDir.');
  }
});
