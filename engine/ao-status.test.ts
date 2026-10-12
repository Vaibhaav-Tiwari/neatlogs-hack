import { describe, expect, it } from 'vitest';
import { parseAoDaemonStatus } from './ao-status.js';

describe('AO daemon status', () => {
  it('accepts the current healthy ready payload and legacy running state', () => {
    expect(parseAoDaemonStatus('{"state":"ready","health":"ok","ready":"ready"}').state).toBe('running');
    expect(parseAoDaemonStatus('{"state":"running"}').state).toBe('running');
  });

  it.each(['{"state":"ready"}', '{"state":"ready","health":"error","ready":"ready"}', '{"state":"unhealthy","health":"ok","ready":"ready"}', 'null', 'not json'])('does not accept unhealthy or incomplete output: %s', (payload) => {
    expect(parseAoDaemonStatus(payload).state).toBe('unknown');
  });

  it('recognises a stopped daemon', () => {
    expect(parseAoDaemonStatus('{"state":"stopped"}').state).toBe('stopped');
  });
});
