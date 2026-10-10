import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import type { LiveUsage } from './ports.js';
import { FakeSessions, FakeUsage, sampleConfig, tokens } from './testing/fakes.js';
import { CeilingWatcher, checkCeiling, type WatchedAttempt } from './watcher.js';

const config = sampleConfig();
const bronze = config.tiers[0]!; // $1 in, $0.10 cached, $5 out per million tokens

const attempt = (overrides: Partial<WatchedAttempt> = {}): WatchedAttempt => ({
  sessionId: 'sess-1',
  tier: bronze,
  ceilingNanos: usdToNanos(0.3),
  ...overrides,
});

/** 100k input + 20k output on bronze = $0.10 + $0.10 = $0.20. */
const under: LiveUsage = { tokens: tokens(100_000, 0, 20_000), estimatedCostNanos: 1 };
/** 100k input + 40k output on bronze = $0.30, exactly the ceiling. */
const at: LiveUsage = { tokens: tokens(100_000, 0, 40_000), estimatedCostNanos: 1 };
/** 200k input + 40k output on bronze = $0.40. */
const over: LiveUsage = { tokens: tokens(200_000, 0, 40_000), estimatedCostNanos: 1 };

describe('checkCeiling', () => {
  it('prices the tokens at the list price of the tier, not the orchestrator estimate', () => {
    const check = checkCeiling(under, attempt());
    expect(check.costNanos).toBe(usdToNanos(0.2));
    expect(check.costSource).toBe('list-price');
    expect(check.crossed).toBe(false);
  });

  it('is crossed once the cost reaches the ceiling', () => {
    expect(checkCeiling(at, attempt()).crossed).toBe(true);
    expect(checkCeiling(over, attempt()).crossed).toBe(true);
  });

  it('is not crossed when there is no usage yet', () => {
    expect(checkCeiling(null, attempt())).toMatchObject({ crossed: false, costNanos: 0 });
  });

  it('is never crossed when the attempt has no ceiling', () => {
    expect(checkCeiling(over, attempt({ ceilingNanos: null })).crossed).toBe(false);
  });

  it('falls back to the orchestrator estimate when the tier has no list price', () => {
    const free = { ...bronze, price: { inputUsdPerMTok: 0, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 0 } };
    const usage = { tokens: tokens(100_000, 0, 20_000), estimatedCostNanos: usdToNanos(0.5) };
    const check = checkCeiling(usage, attempt({ tier: free }));
    expect(check).toMatchObject({ costNanos: usdToNanos(0.5), costSource: 'ao-estimate', crossed: true });
  });
});

describe('CeilingWatcher.poll', () => {
  it('lets an attempt under its ceiling continue', async () => {
    const sessions = new FakeSessions();
    const verdict = await new CeilingWatcher({ usage: new FakeUsage([under]), sessions }).poll(attempt());
    expect(verdict.action).toBe('continue');
    expect(sessions.stopped).toEqual([]);
  });

  it('stops an attempt that has crossed its ceiling', async () => {
    const sessions = new FakeSessions();
    const verdict = await new CeilingWatcher({ usage: new FakeUsage([over]), sessions }).poll(attempt());
    expect(verdict).toMatchObject({ action: 'stop', stopped: true, costNanos: usdToNanos(0.4) });
    expect(verdict.reason).toBe('ceiling crossed: $0.40 spent against a $0.30 ceiling');
    expect(sessions.stopped).toEqual([{ sessionId: 'sess-1', reason: verdict.reason }]);
  });

  it('keeps going when usage cannot be read, and says so', async () => {
    const sessions = new FakeSessions();
    const watcher = new CeilingWatcher({ usage: new FakeUsage([new Error('daemon down')]), sessions });
    const verdict = await watcher.poll(attempt());
    expect(verdict).toMatchObject({ action: 'continue', usageReadable: false });
    expect(sessions.stopped).toEqual([]);
  });

  it('reports a stop that did not take effect', async () => {
    const sessions = new FakeSessions();
    sessions.failWith = new Error('no such session');
    const verdict = await new CeilingWatcher({ usage: new FakeUsage([over]), sessions }).poll(attempt());
    expect(verdict).toMatchObject({ action: 'stop', stopped: false });
  });

  it('never stops an attempt without a ceiling', async () => {
    const sessions = new FakeSessions();
    const watcher = new CeilingWatcher({ usage: new FakeUsage([over]), sessions });
    expect((await watcher.poll(attempt({ ceilingNanos: null }))).action).toBe('continue');
    expect(sessions.stopped).toEqual([]);
  });
});

describe('CeilingWatcher.watch', () => {
  const noSleep = async () => {};

  it('polls until the ceiling is crossed, then stops the session once', async () => {
    const usage = new FakeUsage([null, under, under, over]);
    const sessions = new FakeSessions();
    const verdict = await new CeilingWatcher({ usage, sessions }).watch(attempt(), { sleep: noSleep });
    expect(verdict.action).toBe('stop');
    expect(usage.polls).toBe(4);
    expect(sessions.stopped).toHaveLength(1);
  });

  it('tries the stop again when it fails the first time', async () => {
    const usage = new FakeUsage([over]);
    const sessions = new FakeSessions();
    sessions.failWith = new Error('busy');
    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      sessions.failWith = null;
    };
    const verdict = await new CeilingWatcher({ usage, sessions }).watch(attempt(), { sleep });
    expect(verdict).toMatchObject({ action: 'stop', stopped: true });
    expect(sleeps).toBe(1);
  });

  it('returns when the attempt ends on its own', async () => {
    const controller = new AbortController();
    const usage = new FakeUsage([under]);
    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 3) controller.abort();
    };
    const sessions = new FakeSessions();
    const verdict = await new CeilingWatcher({ usage, sessions }).watch(attempt(), { sleep, signal: controller.signal });
    expect(verdict.action).toBe('continue');
    expect(sessions.stopped).toEqual([]);
  });
});
