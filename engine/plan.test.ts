import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planTally } from './plan.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-plan-'));
  const configPath = join(dir, 'tally.yaml');
  writeFileSync(
    configPath,
    `version: 1
repo: { path: ".", slug: "acme/demo", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: test
    model: cheap-model
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }
    ceilingFraction: 0.2
  - name: top
    harness: codex
    provider: test
    model: top-model
    price: { inputUsdPerMTok: 5, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 5 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 4, large: 10 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
  );
  writeFileSync(
    join(dir, 'backlog.yaml'),
    `tasks:
  - id: T1
    title: Fix \`calc.ts\` should add values
    body: Expected calc.ts to return a + b.
    size: small
`,
  );
  return configPath;
}

describe('planTally', () => {
  it('shows the deliberate first attempt override and rejects invalid values', async () => {
    const configPath = fixture();
    const path = join(dirname(configPath), 'backlog.yaml');
    const body = readFileSync(path, 'utf8');
    writeFileSync(path, `${body}    firstAttemptCeilingUsd: 0.01\n`);
    const options = { configPath, dryRun: true, baseline: false };
    const plan = await planTally(options);
    expect(plan[0]?.ceilingNanos).toBe(10_000_000);
    expect(plan[0]?.decision).toContain('Deliberate first-attempt ceiling override');
    writeFileSync(path, `${body}    firstAttemptCeilingUsd: -1\n`);
    await expect(planTally(options)).rejects.toThrow('positive finite number');
  });
  it('sizes and routes without worker ports', async () => {
    const plan = await planTally({
      configPath: fixture(),
      dryRun: true,
      baseline: false,
      signals: { async signalsFor() { return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' }; } },
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ taskId: 'T1', size: 'small', tier: 'cheap', model: 'cheap-model', skipped: false });
    expect(plan[0]?.decision).toContain('expected to cost');
  });
});
