import { describe, expect, it } from 'vitest';
import { outOfScopeFiles } from './scope.js';
import type { BacklogTask } from './backlog.js';

const task: BacklogTask = { taskId: 'T1', title: 'Fix replay summary', body: 'Preserve summary rows.', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] };

describe('scope guard', () => {
  it('flags infrastructure and root config while allowing source and tests', () => {
    expect(outOfScopeFiles(task, ['src/replay.py', 'tests/replay.test.ts', 'vercel.json', '.github/workflows/test.yml', 'package.json'])).toEqual(['vercel.json', '.github/workflows/test.yml', 'package.json']);
  });
  it('allows files and infrastructure explicitly covered by the task', () => {
    expect(outOfScopeFiles({ ...task, body: 'Fix Vercel deployment and update package.json and CI workflow.' }, ['vercel.json', 'package.json', '.github/workflows/test.yml'])).toEqual([]);
  });
});
