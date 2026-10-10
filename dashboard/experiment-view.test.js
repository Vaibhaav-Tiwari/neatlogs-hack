import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { experimentMatches, experimentMarkup, statRange, validExperiment } from './experiment-view.js';
const summary = JSON.parse(readFileSync(new URL('./experiment-fixture/experiments/exp-scripted-comparison/summary.json', import.meta.url)));
const current = { repo: summary.repo, taskIds: 'E1|E2', kind: 'sample' };
const render = (value) => experimentMarkup(value, { path: './summary.json', pageUrl: 'http://localhost/sub/dashboard/' });
describe('experiment comparison', () => {
  it('matches repository, task set and real/simulated kind', () => {
    expect(experimentMatches(summary, current)).toBe(true);
    expect(experimentMatches({ ...summary, taskIds: ['E2','E1'] }, current)).toBe(true);
    for (const changed of [{ repo: 'other/repo' }, { taskIds: ['E1'] }, { real: true }]) expect(experimentMatches({ ...summary, ...changed }, current)).toBe(false);
  });
  it('shows a single statistic for one repeat and preserves null metrics', () => {
    expect(statRange({ min: 1, median: 1, max: 1 }, String)).toBe('1');
    expect(statRange({ min: null, median: null, max: null }, String)).toContain('none yet');
    expect(statRange({ min: 1, median: 2, max: 3 }, String)).toContain('median 2');
  });
  it('reports losses honestly and names repeat members without claiming merged PRs', () => {
    const html = render(summary);
    expect(html).toContain('36.4% more than baseline');
    expect(html).toContain('-50.0 percentage points');
    expect(html).toContain('sample-tally-2 - repeat 2 - finished');
    expect(html).toContain('Cost per passed task');
    expect(html).toContain('simulated experiment');
    expect(html).toContain('2/2 repeats finished');
  });
  it('shows the waiting state while one mode has no completed run', () => {
    const incomplete = structuredClone(summary); incomplete.status = 'running'; incomplete.modes.baseline.runs = []; incomplete.comparison = { totalCostChangePct: null };
    expect(render(incomplete)).toContain('No comparable baseline yet');
    expect(render(incomplete)).not.toContain('36.4% more');
  });
  it('rejects malformed rows and keeps unsafe URLs/text out of markup', () => {
    expect(validExperiment({ ...summary, modes: { baseline: { runs: [null] }, tally: { runs: [] } } })).toBe(false);
    const unsafe = structuredClone(summary); unsafe.experimentId = '<script>'; unsafe.modes.tally.runs[0].path = 'javascript:alert(1)';
    expect(render(unsafe)).not.toContain('<script>');
    expect(render(unsafe)).not.toContain('javascript:');
  });
});
