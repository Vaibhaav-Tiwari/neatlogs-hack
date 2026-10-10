import { describe, expect, it } from 'vitest';
import type { SizingSignals } from './ports.js';
import { sizeFromSignals, sizeTask, specificity } from './sizer.js';
import { FakeLlm, FakeSignals, RecordingTrace, task } from './testing/fakes.js';

const signals = (overrides: Partial<SizingSignals> = {}): SizingSignals => ({
  filesTouched: 1,
  dependents: 0,
  testsPresent: true,
  source: 'entire-graph',
  ...overrides,
});

const specificBody =
  'Calling `refund.validate(-5)` in src/refund/validator.ts should raise an error, but it returns true.\n' +
  '1. Create a refund of -5\n2. Expected: rejected';

describe('specificity', () => {
  it('is 0 for an empty issue and high for one that names code and expected behaviour', () => {
    expect(specificity(task({ title: 'Improve things', body: '' }))).toBe(0);
    expect(specificity(task({ body: specificBody }))).toBeGreaterThanOrEqual(0.8);
  });
});

describe('sizeFromSignals', () => {
  it('labels a one-file change with no dependents small', () => {
    expect(sizeFromSignals(task(), signals()).size).toBe('small');
  });

  it('labels a change touching several files medium', () => {
    expect(sizeFromSignals(task(), signals({ filesTouched: 4 })).size).toBe('medium');
  });

  it('labels a few files with many dependents by the larger of the two', () => {
    expect(sizeFromSignals(task(), signals({ filesTouched: 2, dependents: 5 })).size).toBe('medium');
    expect(sizeFromSignals(task(), signals({ filesTouched: 2, dependents: 14 })).size).toBe('large');
  });

  it('labels many files large', () => {
    expect(sizeFromSignals(task(), signals({ filesTouched: 9 })).size).toBe('large');
  });

  it('moves a task one size up when the issue asks for a broad change', () => {
    const estimate = sizeFromSignals(task({ title: 'Refactor the export module' }), signals());
    expect(estimate.size).toBe('medium');
  });

  it('is confident about a small, tested, specific task', () => {
    const estimate = sizeFromSignals(task({ body: specificBody }), signals());
    expect(estimate.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('is less confident when the area has no tests', () => {
    const withTests = sizeFromSignals(task(), signals());
    const without = sizeFromSignals(task(), signals({ testsPresent: false }));
    expect(without.confidence).toBeLessThan(withTests.confidence);
  });

  it('is less confident when many things depend on the change', () => {
    const few = sizeFromSignals(task(), signals({ filesTouched: 4 }));
    const many = sizeFromSignals(task(), signals({ filesTouched: 4, dependents: 14 }));
    expect(many.confidence).toBeLessThan(few.confidence);
  });

  it('is less confident when the numbers come from a code search', () => {
    const graph = sizeFromSignals(task(), signals());
    const search = sizeFromSignals(task(), signals({ source: 'code-search' }));
    expect(search.confidence).toBeLessThan(graph.confidence);
  });

  it('falls back to medium with low confidence when there are no signals', () => {
    const estimate = sizeFromSignals(task({ body: specificBody }), null);
    expect(estimate.size).toBe('medium');
    expect(estimate.confidence).toBeLessThanOrEqual(0.3);
  });

  it('keeps confidence within 0 and 1', () => {
    const low = sizeFromSignals(
      task({ title: 'Rewrite everything' }),
      signals({ filesTouched: 40, dependents: 90, testsPresent: false, source: 'code-search' }),
    );
    expect(low.confidence).toBeGreaterThanOrEqual(0);
    expect(sizeFromSignals(task({ body: specificBody }), signals()).confidence).toBeLessThanOrEqual(1);
  });

  it('explains itself in plain words', () => {
    const estimate = sizeFromSignals(task(), signals({ filesTouched: 4, dependents: 9, testsPresent: false }));
    expect(estimate.summary).toBe('4 files touched, 9 dependents and no tests');
  });
});

describe('sizeTask', () => {
  it('uses the rules alone when no LLM is given', async () => {
    const estimate = await sizeTask(task(), { signals: new FakeSignals(signals()) });
    expect(estimate.size).toBe('small');
    expect(estimate.refinedBy).toBe('rules');
  });

  it('treats a failing signals port as no signals', async () => {
    const estimate = await sizeTask(task(), { signals: new FakeSignals(new Error('entire not installed')) });
    expect(estimate.size).toBe('medium');
    expect(estimate.signals).toBeNull();
  });

  it('raises confidence when the LLM agrees', async () => {
    const rules = sizeFromSignals(task(), signals());
    const llm = new FakeLlm('{"size":"small","confidence":0.9}');
    const estimate = await sizeTask(task(), { signals: new FakeSignals(signals()), llm }, { llmModel: 'tiny' });
    expect(estimate.size).toBe('small');
    expect(estimate.refinedBy).toBe('llm');
    expect(estimate.confidence).toBeGreaterThan(rules.confidence);
    expect(llm.requests[0]?.model).toBe('tiny');
  });

  it('takes the larger size and lowers confidence when the LLM disagrees', async () => {
    const rules = sizeFromSignals(task(), signals());
    const llm = new FakeLlm('Sure! ```json\n{"size":"large","confidence":0.8}\n```');
    const estimate = await sizeTask(task(), { signals: new FakeSignals(signals()), llm });
    expect(estimate.size).toBe('large');
    expect(estimate.confidence).toBeLessThan(rules.confidence);
  });

  it('never lets the LLM make a task smaller than the rules say', async () => {
    const llm = new FakeLlm('{"size":"small","confidence":1}');
    const estimate = await sizeTask(task(), { signals: new FakeSignals(signals({ filesTouched: 9 })), llm });
    expect(estimate.size).toBe('large');
  });

  it.each([
    ['an error', new Error('gateway down')],
    ['prose', 'I think it is small.'],
    ['an unknown size', '{"size":"tiny","confidence":0.9}'],
    ['a confidence out of range', '{"size":"small","confidence":7}'],
  ])('keeps the rules result when the LLM returns %s', async (_label, reply) => {
    const rules = sizeFromSignals(task(), signals());
    const estimate = await sizeTask(task(), { signals: new FakeSignals(signals()), llm: new FakeLlm(reply) });
    expect(estimate).toEqual(rules);
  });

  it('sends the issue and the signals to the LLM, and nothing from the environment', async () => {
    const llm = new FakeLlm('{"size":"small","confidence":0.9}');
    await sizeTask(task({ title: 'Fix refund', body: 'x'.repeat(10_000) }), { signals: new FakeSignals(signals()), llm });
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain('Fix refund');
    expect(prompt).toContain('Files touched: 1');
    expect(prompt.length).toBeLessThan(6_000);
  });

  it('traces the sizing decision when a trace port is provided', async () => {
    const trace = new RecordingTrace();
    await sizeTask(task(), { signals: new FakeSignals(signals()), trace });
    expect(trace.spans).toEqual([
      {
        name: 'tally.size',
        attributes: { taskId: 'T1', size: 'small', confidence: 0.7, refinedBy: 'rules', signalsSource: 'entire-graph' },
        error: null,
      },
    ]);
  });
});
