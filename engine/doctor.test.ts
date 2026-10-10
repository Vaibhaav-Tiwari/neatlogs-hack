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
      throw new Error(command);
    };
    const lines = await runDoctor({
      runner,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'ok', detail: 'Tally cached token works against https://api.cfo.ai/mcp' }),
    });
    expect(lines.find((line) => line.product === 'AO daemon')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'GitHub CLI')).toMatchObject({ status: 'missing', fix: 'gh auth login' });
    expect(lines.find((line) => line.product === 'Entire graph plugin')).toMatchObject({ status: 'broken', fix: 'entire enable' });
    expect(lines.find((line) => line.product === 'neatlogs key')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({ status: 'connected' });
  });

  it('reports cfo.ai from Tally token state with the Tally login fix', async () => {
    const runner: DoctorRunner = async () => ({ stdout: 'ok', stderr: '' });
    const lines = await runDoctor({
      runner,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'missing', detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.' }),
    });

    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({
      status: 'missing',
      detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.',
      fix: 'tally login cfoai',
    });
  });
});
