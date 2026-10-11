import { CommandError } from './command.js';

/** Read/write the full daemon config; the CLI mirror omits fields such as effort. */
export async function aoProjectCommand(args: string[], fetchImpl: typeof fetch = fetch): Promise<{ stdout: string; stderr: string }> {
  const editing = args[1] === 'set-config';
  const id = encodeURIComponent(args[2]!);
  const response = await fetchImpl(`http://127.0.0.1:3001/api/v1/projects/${id}${editing ? '/config' : ''}`, {
    method: editing ? 'PUT' : 'GET',
    ...(editing ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: JSON.parse(args[args.indexOf('--config-json') + 1]!) }) } : {}),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new CommandError('AO project API could not be reached; start AO and retry.'); });
  if (!response.ok) throw new CommandError(`AO project ${args[1]} failed: HTTP ${response.status}; check AO is running before retrying.`);
  return { stdout: JSON.stringify(await response.json()), stderr: '' };
}
