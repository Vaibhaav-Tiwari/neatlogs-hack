#!/usr/bin/env node
// Replay a finished Tally run as live-updating run.json and ledger.json files.
// Usage: node dashboard/replay.mjs [source-dir] [output-dir] [seconds]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { frameAt } from './replay-core.js';

const [, , sourceArg = 'schema/fixtures/finished-run', outputArg = 'dashboard', secondsArg = '60'] = process.argv;
const seconds = Math.max(5, Number(secondsArg) || 60);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeFrame(outputDir, state) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'run.json'), `${JSON.stringify(state.run, null, 2)}\n`);
  await writeFile(join(outputDir, 'ledger.json'), `${JSON.stringify(state.ledger, null, 2)}\n`);
}

const run = await readJson(join(sourceArg, 'run.json'));
const ledger = await readJson(join(sourceArg, 'ledger.json'));
const started = Date.now();

await writeFrame(outputArg, frameAt(run, ledger, 0));

const timer = setInterval(async () => {
  const fraction = Math.min(1, (Date.now() - started) / (seconds * 1000));
  await writeFrame(outputArg, frameAt(run, ledger, fraction));
  if (fraction >= 1) clearInterval(timer);
}, 1000);
