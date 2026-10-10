import { describe, expect, it } from 'vitest';
import { runDoctor, type DoctorRunner } from './doctor.js';

describe('runDoctor', () => {
  it('reports product status and exact fix commands', async () => {
    const runner: DoctorRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'ao status') return { stdout: 'ok', stderr: '' };
      if (command === 'gh auth status') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (command === 'entire --version') return { stdout: 'entire 1', stderr: '' };
      if (command === 'entire graph --help') throw new Error('no graph');
      if (command === 'claude mcp list') return { stdout: 'cfoai connected', stderr: '' };
      throw new Error(command);
    };
    const lines = await runDoctor({ runner, env: { NEATLOGS_API_KEY: 'set' } });
    expect(lines.find((line) => line.product === 'AO daemon')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'GitHub CLI')).toMatchObject({ status: 'missing', fix: 'gh auth login' });
    expect(lines.find((line) => line.product === 'Entire graph plugin')).toMatchObject({ status: 'broken', fix: 'entire enable' });
    expect(lines.find((line) => line.product === 'neatlogs key')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({ status: 'connected' });
  });
});
