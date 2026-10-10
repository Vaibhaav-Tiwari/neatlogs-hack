import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultEnvPath } from '../engine/env.js';

/** Keep unrelated dotenv lines; refuse symlinks and multiline values. */
export function saveSecrets(values: Record<string, string>, path = defaultEnvPath()): void {
  for (const [key, value] of Object.entries(values)) {
    if (!/^NEATLOGS_(API_KEY|TOKEN|PROJECT_ID)$/.test(key) || !/^[^\s"'`\\#]+$/.test(value)) throw new Error('Invalid secret input');
  }
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('Unsafe secrets file');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error('Unsafe secrets directory');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const remaining = lines.filter(line => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    return !key || !(key in values);
  });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, [...remaining, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join('\n'), { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

/** No visible readline output, masking characters, telemetry or secret-bearing errors. */
export async function readHiddenSecret(question: string, options: {
  input?: typeof process.stdin;
  output?: typeof process.stdout;
} = {}): Promise<string | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) return null;
  output.write(`${question} (hidden; blank to skip): `);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise(resolve => {
    let value = '';
    const finish = (answer: string | null) => {
      input.off('data', receive);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      resolve(answer);
    };
    const receive = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { finish(null); return; }
        if (char === '\r' || char === '\n') { finish(value.trim() || null); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char <= '~' && value.length < 8192) value += char;
      }
    };
    input.on('data', receive);
  });
}
