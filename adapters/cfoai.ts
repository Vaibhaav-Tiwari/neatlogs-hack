import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { IntegrationState, TallyConfig } from '../schema/types.js';
import { nanosToUsd, usdToNanos } from '../schema/money.js';
import type { BudgetPort } from '../agent/ports.js';

export const CFOAI_SERVER_URL = 'https://api.cfo.ai/mcp';
export const CFOAI_FIX_COMMAND = 'Run `tally login cfoai` to connect cfo.ai.';

export interface CfoaiBudgetConfig {
  orgId?: string;
  scenario?: string;
  table?: string;
  budgetRow?: string;
  spendRow?: string;
  remainingRow?: string;
  tableUrl?: string;
  serverUrl?: string;
}

export interface NormalizedCfoaiBudgetConfig {
  orgId?: string;
  scenario?: string;
  table: string;
  budgetRow: string;
  spendRow: string;
  remainingRow: string;
  tableUrl?: string;
  serverUrl: string;
}

export interface CfoaiMcpClient {
  connect(): Promise<void>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CfoaiTokenStoreData {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface CfoaiLoginResult {
  status: 'ok' | 'needs-browser';
  authorizationUrl?: string;
  tokenPath: string;
}

export interface CfoaiConnectionCheckOptions {
  config?: CfoaiBudgetConfig;
  tokenPath?: string;
  client?: CfoaiMcpClient;
}

export function defaultCfoaiTokenPath(): string {
  return join(homedir(), '.tally', 'cfoai-oauth.json');
}

export function normalizeCfoaiConfig(config: CfoaiBudgetConfig | undefined): NormalizedCfoaiBudgetConfig {
  return {
    orgId: config?.orgId,
    scenario: config?.scenario,
    table: config?.table ?? 'Tally agent budget',
    budgetRow: config?.budgetRow ?? 'Agent budget',
    spendRow: config?.spendRow ?? 'Agent spend',
    remainingRow: config?.remainingRow ?? 'Budget remaining',
    tableUrl: config?.tableUrl,
    serverUrl: config?.serverUrl ?? CFOAI_SERVER_URL,
  };
}

export function cfoaiMonthColumn(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function refreshTokenRequest(tokens: OAuthTokens | undefined, scope?: string): URLSearchParams | undefined {
  const refreshToken = tokens?.refresh_token;
  if (!refreshToken) return undefined;
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (scope) params.set('scope', scope);
  return params;
}

class FileTokenStore {
  constructor(private readonly path = defaultCfoaiTokenPath()) {}

  get tokenPath(): string {
    return this.path;
  }

  read(): CfoaiTokenStoreData {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as CfoaiTokenStoreData;
    } catch {
      return {};
    }
  }

  write(data: CfoaiTokenStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }

  patch(update: Partial<CfoaiTokenStoreData>): void {
    this.write({ ...this.read(), ...update });
  }
}

class CfoaiOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;

  constructor(
    private readonly store: FileTokenStore,
    private readonly redirect: string | undefined,
    private readonly openUrl: (url: URL) => Promise<void>,
  ) {}

  get redirectUrl(): string | undefined {
    return this.redirect;
  }

  get clientMetadata() {
    return {
      client_name: 'Tally',
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.store.patch({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read().tokens;
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    return refreshTokenRequest(this.tokens(), scope);
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.patch({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl;
    await this.openUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.patch({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.store.read().codeVerifier;
    if (!verifier) throw new Error('cfo.ai OAuth verifier is missing; run `tally login cfoai` again');
    return verifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.store.patch({ discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.read().discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const current = this.store.read();
    if (scope === 'all') return this.store.write({});
    if (scope === 'client') delete current.clientInformation;
    if (scope === 'tokens') delete current.tokens;
    if (scope === 'verifier') delete current.codeVerifier;
    if (scope === 'discovery') delete current.discoveryState;
    this.store.write(current);
  }
}

class SdkCfoaiMcpClient implements CfoaiMcpClient {
  private readonly client = new Client({ name: 'tally', version: '0.1.0' });
  private readonly transport: StreamableHTTPClientTransport;

  constructor(serverUrl: string, authProvider: OAuthClientProvider) {
    this.transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<{ tools: { name: string }[] }> {
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async finishAuth(code: string): Promise<void> {
    await this.transport.finishAuth(code);
  }
}

export interface CfoaiBudgetAdapterOptions {
  config?: CfoaiBudgetConfig;
  client?: CfoaiMcpClient;
  now?: () => Date;
}

export class CfoaiBudgetAdapter implements BudgetPort {
  private readonly config: NormalizedCfoaiBudgetConfig;
  private readonly now: () => Date;
  private connected = false;
  private usable = false;
  private statusState: IntegrationState = { status: 'missing', detail: CFOAI_FIX_COMMAND };
  private toolsChecked = false;
  private runBaseSpendNanos: number | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(options: CfoaiBudgetAdapterOptions = {}) {
    this.config = normalizeCfoaiConfig(options.config);
    this.now = options.now ?? (() => new Date());
    this.client =
      options.client ??
      new SdkCfoaiMcpClient(this.config.serverUrl, new CfoaiOAuthProvider(new FileTokenStore(), undefined, async () => undefined));
  }

  private readonly client: CfoaiMcpClient;

  status(): IntegrationState {
    return this.statusState;
  }

  tableUrl(): string | undefined {
    return this.config.tableUrl;
  }

  async budgetLimitNanos(): Promise<number> {
    await this.ensureReady();
    return usdToNanos(await this.readUsd(this.config.budgetRow));
  }

  async currentSpendNanos(): Promise<number> {
    await this.ensureReady();
    return usdToNanos(await this.readUsd(this.config.spendRow));
  }

  async remainingNanos(): Promise<number> {
    const [budget, spend] = await Promise.all([this.budgetLimitNanos(), this.currentSpendNanos()]);
    return budget - spend;
  }

  async writeCumulativeActualSpend(runSpendNanos: number): Promise<void> {
    await this.ensureReady();
    try {
      if (this.runBaseSpendNanos === null) this.runBaseSpendNanos = await this.currentSpendNanos();
      const total = this.runBaseSpendNanos + runSpendNanos;
      const usd = Number(nanosToUsd(total).toFixed(9));
      const result = await this.client.callTool('edit_table_blocks', {
        ...this.scopeArgs(),
        update: {
          target: this.config.table,
          values: { columns: [this.monthColumn()], rows: [[this.config.spendRow, usd]] },
        },
      });
      if (receiptStatus(result) !== 'applied') {
        throw new Error('cfo.ai did not apply the spend update');
      }
      const readBack = usdToNanos(await this.readUsd(this.config.spendRow));
      if (Math.abs(readBack - total) > 1) {
        throw new Error('cfo.ai spend read-back did not match the applied update');
      }
    } catch (e) {
      this.statusState = { status: 'missing', detail: `${(e as Error).message}. ${CFOAI_FIX_COMMAND}` };
      throw e;
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.usable) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.connectAndCheckTools().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  private async connectAndCheckTools(): Promise<void> {
    try {
      if (!this.connected) {
        await this.client.connect();
        this.connected = true;
      }
      if (!this.toolsChecked) {
        const listed = await this.client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        for (const name of ['inspect_table_blocks', 'edit_table_blocks']) {
          if (!names.has(name)) throw new Error(`cfo.ai MCP tool ${name} is missing`);
        }
        this.toolsChecked = true;
      }
      this.usable = true;
      this.statusState = { status: 'ok', detail: this.config.tableUrl ?? null };
    } catch (e) {
      this.statusState = { status: 'missing', detail: `${(e as Error).message}. ${CFOAI_FIX_COMMAND}` };
      throw e;
    }
  }

  private async readUsd(row: string): Promise<number> {
    const result = await this.client.callTool('inspect_table_blocks', {
      ...this.scopeArgs(),
      read: { target: this.config.table, rows: [row], columns: [this.monthColumn()] },
    });
    return extractUsd(result, row, this.monthColumn());
  }

  private monthColumn(): string {
    return cfoaiMonthColumn(this.now());
  }

  private scopeArgs(): Record<string, string> {
    return {
      ...(this.config.orgId ? { org_id: this.config.orgId } : {}),
      ...(this.config.scenario ? { scenario: this.config.scenario } : {}),
    };
  }
}

function receiptStatus(value: unknown): string | null {
  const parsed = unwrapToolResult(value);
  if (isRecord(parsed) && typeof parsed.status === 'string') return parsed.status;
  return null;
}

function extractUsd(value: unknown, row: string, column: string): number {
  const parsed = unwrapToolResult(value);
  const tabular = findTabularNumber(parsed, row, column);
  if (tabular !== null) return tabular;
  const candidates = [
    isRecord(parsed) ? parsed.value : undefined,
    isRecord(parsed) ? parsed.values : undefined,
  ];
  for (const candidate of candidates) {
    const found = findNumber(candidate, row, column);
    if (found !== null) return found;
  }
  throw new Error(`cfo.ai response did not include ${row} / ${column}`);
}

function findNumber(value: unknown, row: string, column: string): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (Array.isArray(value)) {
    if (value.length >= 2 && value[0] === row) {
      const direct = findNumber(value[1], row, column);
      if (direct !== null) return direct;
    }
    for (const item of value) {
      const found = findNumber(item, row, column);
      if (found !== null) return found;
    }
  }
  if (isRecord(value)) {
    if (row in value) {
      const found = findNumber(value[row], row, column);
      if (found !== null) return found;
    }
    if (column in value) {
      const found = findNumber(value[column], row, column);
      if (found !== null) return found;
    }
    for (const item of Object.values(value)) {
      const found = findNumber(item, row, column);
      if (found !== null) return found;
    }
  }
  return null;
}

function findTabularNumber(value: unknown, row: string, column: string): number | null {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null;
  const columns = Array.isArray(value.columns) ? value.columns : [];
  for (const candidate of value.rows) {
    if (!isRecord(candidate)) continue;
    const displayName = typeof candidate.display_name === 'string' ? candidate.display_name : typeof candidate.name === 'string' ? candidate.name : null;
    if (displayName !== row) continue;
    const values = Array.isArray(candidate.values) ? candidate.values : [];
    const index = columnIndex(columns, column);
    const cell = values[index >= 0 ? index : 0];
    const direct = isRecord(cell) && 'value' in cell ? cell.value : cell;
    return exactNumber(direct);
  }
  return null;
}

function columnIndex(columns: unknown[], column: string): number {
  return columns.findIndex((candidate) => {
    if (!isRecord(candidate)) return false;
    const ref = typeof candidate.ref === 'string' ? candidate.ref : '';
    const displayName = typeof candidate.display_name === 'string' ? candidate.display_name : '';
    return ref.startsWith(column) || displayName === column;
  });
}

function exactNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function unwrapToolResult(value: unknown): unknown {
  if (isRecord(value)) {
    if ('structuredContent' in value) return value.structuredContent;
    if ('toolResult' in value) return value.toolResult;
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
      if (isRecord(text) && typeof text.text === 'string') {
        try {
          return JSON.parse(text.text) as unknown;
        } catch {
          return text.text;
        }
      }
    }
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function openInBrowser(url: URL): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', String(url)] : [String(url)];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function loginCfoai(options: {
  config?: CfoaiBudgetConfig;
  tokenPath?: string;
  openUrl?: (url: URL) => Promise<void>;
  timeoutMs?: number;
} = {}): Promise<CfoaiLoginResult> {
  const normalized = normalizeCfoaiConfig(options.config);
  const tokenStore = new FileTokenStore(options.tokenPath);
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const received = url.searchParams.get('code');
    if (received) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('cfo.ai is connected. You can close this tab.\n');
      resolveCode(received);
    } else {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Missing OAuth code.\n');
      rejectCode(new Error('cfo.ai OAuth callback did not include a code'));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not start local cfo.ai OAuth callback server');
  const provider = new CfoaiOAuthProvider(tokenStore, `http://127.0.0.1:${address.port}/callback`, options.openUrl ?? openInBrowser);
  const client = new SdkCfoaiMcpClient(normalized.serverUrl, provider);
  try {
    await client.connect().catch((error: unknown) => {
      if (provider.authorizationUrl) return;
      throw error;
    });
    if (!provider.authorizationUrl) {
      await client.listTools();
      await client.close();
      return { status: 'ok', tokenPath: tokenStore.tokenPath };
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for the cfo.ai browser approval')), options.timeoutMs ?? 120_000).unref();
    });
    const authorizationCode = await Promise.race([code, timeout]);
    await client.finishAuth(authorizationCode);
    await client.close();
    const verified = new SdkCfoaiMcpClient(normalized.serverUrl, provider);
    await verified.connect();
    await verified.listTools();
    await verified.close();
    return { status: 'ok', tokenPath: tokenStore.tokenPath };
  } finally {
    server.close();
  }
}

export async function checkCfoaiConnection(options: CfoaiConnectionCheckOptions = {}): Promise<IntegrationState> {
  const normalized = normalizeCfoaiConfig(options.config);
  const tokenStore = new FileTokenStore(options.tokenPath);
  if (!options.client && !tokenStore.read().tokens) {
    return { status: 'missing', detail: `Tally has no cached cfo.ai token. ${CFOAI_FIX_COMMAND}` };
  }
  const client =
    options.client ??
    new SdkCfoaiMcpClient(normalized.serverUrl, new CfoaiOAuthProvider(tokenStore, undefined, async () => undefined));
  try {
    await client.connect();
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const name of ['inspect_table_blocks', 'edit_table_blocks']) {
      if (!names.has(name)) throw new Error(`cfo.ai MCP tool ${name} is missing`);
    }
    await client.close();
    return { status: 'ok', detail: `Tally cached token works against ${normalized.serverUrl}` };
  } catch (e) {
    try {
      await client.close();
    } catch {
      // The connection was not open.
    }
    return { status: 'missing', detail: `${(e as Error).message}. ${CFOAI_FIX_COMMAND}` };
  }
}
