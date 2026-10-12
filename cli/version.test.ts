import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { VERSION } from './main.js';

it('reports the same version as the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(VERSION).toBe(manifest.version);
});
