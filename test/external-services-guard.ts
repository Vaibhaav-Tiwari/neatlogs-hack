import { afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guard = vi.hoisted(() => ({ home: process.env.HOME, violations: [] as string[],
  fail(message: string): never { this.violations.push(message); throw new Error(message); },
  wrap<T extends object>(actual: T, name: keyof T, safe: (args: any[], target: any) => boolean): T {
    const constructor = actual[name] as new (...args: any[]) => object;
    return { ...actual, [name]: new Proxy(constructor, { construct(target, args) {
      if (!safe(args, target)) guard.fail(`Tests must inject fake dependencies into ${String(name)}; live adapters are forbidden.`);
      return Reflect.construct(target, args);
    } }) };
  },
}));

vi.mock('../adapters/cfoai.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/cfoai.js')>(), 'CfoaiBudgetAdapter', (args, target) => Boolean(args[0]?.client) || ['budgetLimitNanos', 'currentSpendNanos', 'close'].every(name => vi.isMockFunction(target.prototype[name]))));
vi.mock('../adapters/publisher.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/publisher.js')>(), 'GitHubPublisher', args => typeof args[0] === 'function'));
vi.mock('../adapters/github.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/github.js')>(), 'GithubIssueIntake', args => typeof args[0] === 'function'));
vi.mock('../adapters/neatlogs.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/neatlogs.js')>(), 'NeatlogsTraceAdapter', args => Boolean(args[0]?.env && (args[0]?.sdk !== undefined || args[0]?.loadSdk))));
vi.mock('../adapters/neatlogs-worker-traces.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/neatlogs-worker-traces.js')>(), 'NeatlogsWorkerTraceReader', args => Boolean(args[0]?.env && args[0]?.fetch)));
vi.mock('../adapters/neatlogs-worker-spool.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/neatlogs-worker-spool.js')>(), 'NeatlogsWorkerSpoolAdapter', args => Boolean(args[0]?.root && args[0]?.exporter)));
vi.mock('../adapters/neatlogs-history.js', async importOriginal => guard.wrap(await importOriginal<typeof import('../adapters/neatlogs-history.js')>(), 'NeatlogsPriceHistory', (args, target) => vi.isMockFunction(target.prototype.lookup) || Boolean(args[0]?.env && (args[0]?.fetch || !args[0]?.env.NEATLOGS_TOKEN))));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { homedir } = await import('node:os');
  const { resolve, sep } = await import('node:path');
  const protectedRoot = resolve(guard.home ?? homedir(), '.tally');
  const check = (path: unknown) => {
    if (typeof path !== 'string' && !Buffer.isBuffer(path) && !(path instanceof URL)) return;
    const resolved = resolve(path instanceof URL ? path.pathname : path.toString());
    if (resolved === protectedRoot || resolved.startsWith(protectedRoot + sep)) guard.fail(`Tests must not read the real ~/.tally directory: ${resolved}`);
  };
  const guarded = { ...actual };
  for (const name of ['readFileSync', 'readdirSync', 'openSync', 'existsSync'] as const) {
    guarded[name] = ((...args: any[]) => { check(args[0]); return (actual[name] as Function)(...args); }) as any;
  }
  return { ...guarded, default: guarded };
});

// Subprocess tests inherit an empty home, never the developer's credentials.
const testHome = mkdtempSync(join(tmpdir(), 'tally-suite-home-'));
process.env.HOME = testHome;
afterAll(() => { process.env.HOME = guard.home; rmSync(testHome, { recursive: true, force: true }); });

// Report even violations swallowed by an adapter's normal fallback handling.
afterEach(() => {
  const violations = guard.violations.splice(0);
  if (violations.length) throw new Error([...new Set(violations)].join('\n'));
});
