import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import type { Ledger, RunState } from '../schema/types.js';
import { writeRunFiles } from './output.js';

it('external polling sees complete JSON throughout repeated run and ledger replacements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-output-'));
  const run = JSON.parse(readFileSync(resolve('schema/fixtures/finished-run/run.json'), 'utf8')) as RunState;
  const ledger = JSON.parse(readFileSync(resolve('schema/fixtures/finished-run/ledger.json'), 'utf8')) as Ledger;
  const output = join(dir, 'run');
  const latest = join(dir, 'latest');
  writeRunFiles(output, run, ledger, latest);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    let polls = 0;
    const poll = () => {
      try { for (const file of workerData) JSON.parse(fs.readFileSync(file, 'utf8')); polls++; }
      catch (error) { parentPort.postMessage({ error: error.message }); }
    };
    poll(); parentPort.postMessage({ ready: true });
    const timer = setInterval(poll, 1);
    parentPort.once('message', () => { clearInterval(timer); poll(); parentPort.postMessage({ polls }); });
  `, { eval: true, workerData: [output, latest].flatMap(root => [join(root, 'run.json'), join(root, 'ledger.json')]) });
  const errors: string[] = [];
  worker.on('message', message => { if (message.error) errors.push(message.error); });
  try {
    await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
    for (let i = 0; i < 100; i++) writeRunFiles(output, { ...run, updatedAt: new Date(i).toISOString() }, ledger, latest);
    const done = new Promise<number>(resolve => worker.on('message', message => { if (message.polls) resolve(message.polls); }));
    worker.postMessage('done');
    expect(await done).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);
