import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { formatUsd, nanosToUsd, usdToNanos } from '../schema/money.js';
export const CFOAI_SERVER_URL = 'https://api.cfo.ai/mcp';
export const CFOAI_FIX_COMMAND = 'Run `tally login cfoai` to connect cfo.ai.';
export function defaultCfoaiTokenPath() {
    return join(homedir(), '.tally', 'cfoai-oauth.json');
}
export function normalizeCfoaiConfig(config) {
    return {
        orgId: config?.orgId,
        scenario: config?.scenario,
        table: config?.table ?? 'Tally agent budget',
        budgetRow: config?.budgetRow ?? 'Agent budget',
        spendRow: config?.spendRow ?? 'Agent spend',
        remainingRow: config?.remainingRow ?? 'Budget remaining',
        spendDetailTable: config?.spendDetailTable ?? 'Tally spend detail',
        spendDetailTableUrl: config?.spendDetailTableUrl,
        tierSpendRows: config?.tierSpendRows ?? {
            cheap: 'Tier spend - cheap',
            middle: 'Tier spend - middle',
            top: 'Tier spend - top',
        },
        runSpendRow: config?.runSpendRow ?? 'Run spend - current',
        cumulativeRunSpendRow: config?.cumulativeRunSpendRow ?? 'Run spend - cumulative',
        tableUrl: config?.tableUrl,
        serverUrl: config?.serverUrl ?? CFOAI_SERVER_URL,
    };
}
export function cfoaiMonthColumn(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
export function refreshTokenRequest(tokens, scope) {
    const refreshToken = tokens?.refresh_token;
    if (!refreshToken)
        return undefined;
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (scope)
        params.set('scope', scope);
    return params;
}
class FileTokenStore {
    path;
    constructor(path = defaultCfoaiTokenPath()) {
        this.path = path;
    }
    get tokenPath() {
        return this.path;
    }
    read() {
        try {
            return JSON.parse(readFileSync(this.path, 'utf8'));
        }
        catch {
            return {};
        }
    }
    write(data) {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    }
    patch(update) {
        this.write({ ...this.read(), ...update });
    }
}
class CfoaiOAuthProvider {
    store;
    redirect;
    openUrl;
    authorizationUrl = null;
    constructor(store, redirect, openUrl) {
        this.store = store;
        this.redirect = redirect;
        this.openUrl = openUrl;
    }
    get redirectUrl() {
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
    clientInformation() {
        return this.store.read().clientInformation;
    }
    saveClientInformation(clientInformation) {
        this.store.patch({ clientInformation });
    }
    tokens() {
        return this.store.read().tokens;
    }
    prepareTokenRequest(scope) {
        return refreshTokenRequest(this.tokens(), scope);
    }
    saveTokens(tokens) {
        this.store.patch({ tokens });
    }
    async redirectToAuthorization(authorizationUrl) {
        this.authorizationUrl = authorizationUrl;
        await this.openUrl(authorizationUrl);
    }
    saveCodeVerifier(codeVerifier) {
        this.store.patch({ codeVerifier });
    }
    codeVerifier() {
        const verifier = this.store.read().codeVerifier;
        if (!verifier)
            throw new Error('cfo.ai OAuth verifier is missing; run `tally login cfoai` again');
        return verifier;
    }
    saveDiscoveryState(discoveryState) {
        this.store.patch({ discoveryState });
    }
    discoveryState() {
        return this.store.read().discoveryState;
    }
    invalidateCredentials(scope) {
        const current = this.store.read();
        if (scope === 'all')
            return this.store.write({});
        if (scope === 'client')
            delete current.clientInformation;
        if (scope === 'tokens')
            delete current.tokens;
        if (scope === 'verifier')
            delete current.codeVerifier;
        if (scope === 'discovery')
            delete current.discoveryState;
        this.store.write(current);
    }
}
class SdkCfoaiMcpClient {
    client = new Client({ name: 'tally', version: '0.1.0' });
    transport;
    constructor(serverUrl, authProvider) {
        this.transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
    }
    async connect() {
        await this.client.connect(this.transport);
    }
    async listTools() {
        return this.client.listTools();
    }
    async callTool(name, args) {
        return this.client.callTool({ name, arguments: args });
    }
    async close() {
        await this.client.close();
    }
    async finishAuth(code) {
        await this.transport.finishAuth(code);
    }
}
/** A separate MCP connection using only Tally's own OAuth cache. */
export function createCfoaiClient(tokenPath) {
    return new SdkCfoaiMcpClient(CFOAI_SERVER_URL, new CfoaiOAuthProvider(new FileTokenStore(tokenPath), undefined, async () => undefined));
}
export class CfoaiBudgetAdapter {
    config;
    now;
    connected = false;
    usable = false;
    statusState = { status: 'missing', detail: CFOAI_FIX_COMMAND };
    toolsChecked = false;
    runBaseSpendNanos = null;
    baseDetailSpendNanos = null;
    seededDetailGapNanos = 0;
    readyPromise = null;
    toolSchemas = new Map();
    constructor(options = {}) {
        this.config = normalizeCfoaiConfig(options.config);
        this.now = options.now ?? (() => new Date());
        this.client =
            options.client ??
                new SdkCfoaiMcpClient(this.config.serverUrl, new CfoaiOAuthProvider(new FileTokenStore(), undefined, async () => undefined));
    }
    client;
    status() {
        return this.statusState;
    }
    tableUrl() {
        return this.config.tableUrl;
    }
    spendDetailTableUrl() {
        return this.config.spendDetailTableUrl;
    }
    async budgetLimitNanos() {
        await this.ensureReady();
        return usdToNanos(await this.readUsd(this.config.budgetRow));
    }
    async currentSpendNanos() {
        await this.ensureReady();
        return usdToNanos(await this.readUsd(this.config.spendRow));
    }
    async remainingNanos() {
        const [budget, spend] = await Promise.all([this.budgetLimitNanos(), this.currentSpendNanos()]);
        return budget - spend;
    }
    async close() {
        await this.client.close();
        this.connected = false;
        this.usable = false;
    }
    async writeCumulativeActualSpend(runSpendNanos) {
        await this.ensureReady();
        try {
            if (this.runBaseSpendNanos === null)
                this.runBaseSpendNanos = await this.currentSpendNanos();
            const total = this.runBaseSpendNanos + runSpendNanos;
            const usd = Number(nanosToUsd(total).toFixed(9));
            const result = await this.client.callTool('edit_table_blocks', {
                ...this.scopeArgs(),
                update: {
                    target: this.config.table,
                    values: { columns: [this.monthColumn()], rows: [[this.config.spendRow, usd]] },
                },
            });
            if (!successfulEdit(result)) {
                throw new Error('cfo.ai did not apply the spend update');
            }
            const readBack = usdToNanos(await this.readUsd(this.config.spendRow));
            if (Math.abs(readBack - total) > 1) {
                throw new Error('cfo.ai spend read-back did not match the applied update');
            }
        }
        catch (e) {
            this.statusState = { status: 'error', detail: `write failed: ${e.message}; actual spend is retained in the run CSV fallback.` };
            throw e;
        }
    }
    async writeSpendDetail(input) {
        await this.ensureReady();
        const runTotals = new Map();
        const skippedTiers = new Set();
        for (const attempt of input.attempts) {
            const row = this.config.tierSpendRows[attempt.tier];
            if (!row) {
                skippedTiers.add(attempt.tier);
                continue;
            }
            runTotals.set(row, (runTotals.get(row) ?? 0) + attempt.costNanos);
        }
        const mappedRows = [...new Set(Object.values(this.config.tierSpendRows))];
        if (this.baseDetailSpendNanos === null) {
            await this.loadBaseDetailSpend(mappedRows);
        }
        const updates = new Map();
        for (const row of mappedRows) {
            updates.set(row, this.baseDetailSpendNanos.get(row) ?? 0);
        }
        for (const [row, runSpend] of runTotals) {
            updates.set(row, (updates.get(row) ?? 0) + runSpend);
        }
        updates.set(this.config.runSpendRow, input.cumulativeRunSpendNanos);
        updates.set(this.config.cumulativeRunSpendRow, (this.runBaseSpendNanos ?? (await this.currentSpendNanos())) + input.cumulativeRunSpendNanos);
        await this.writeRows(this.config.spendDetailTable, updates);
        await this.verifyRows(this.config.spendDetailTable, updates);
        await this.verifyAgentSpendMatchesTierRows(mappedRows, skippedTiers.size === 0);
        const notes = [];
        if (skippedTiers.size > 0)
            notes.push(`Skipped cfo.ai spend detail for unmapped tiers: ${[...skippedTiers].join(', ')}.`);
        if (this.seededDetailGapNanos > 0)
            notes.push(`Seeded ${formatUsd(this.seededDetailGapNanos)} of prior Agent spend into ${mappedRows[0]}.`);
        this.setOkStatus(notes.join(' ') || undefined);
        return { skippedTiers: [...skippedTiers] };
    }
    async publishTaskContext(document) {
        await this.ensureReady();
        if (!this.config.orgId)
            throw new Error('cfo.ai organization memory needs the selected workspace ID');
        const schema = this.toolSchemas.get('edit_memory');
        if (!schema)
            throw new Error('cfo.ai memory tool is unavailable or did not publish an input schema');
        const args = {
            org_id: this.config.orgId,
            idempotency_key: document.idempotencyKey,
            retain_document: {
                content: document.content,
                filename: document.filename,
                scope: 'organization',
                tags: document.tags,
                metadata: document.metadata,
            },
        };
        const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
        if (!validate(args)) {
            const detail = validate.errors?.slice(0, 3).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
            throw new Error(`cfo.ai memory tool rejected its published schema${detail ? `: ${detail}` : ''}`);
        }
        try {
            const result = await this.client.callTool('edit_memory', args);
            if (isRecord(result) && result.isError === true)
                throw new Error(cfoaiRefusalMessage(result));
            const parsed = unwrapToolResult(result);
            if (isRecord(parsed) && (parsed.status === 'rejected' || parsed.status === 'error')) {
                throw new Error(cfoaiRefusalMessage(parsed));
            }
            this.setOkStatus('Ari task context was shared with organization memory.');
        }
        catch (error) {
            const detail = safeCfoaiError(error);
            // Organization memory is optional reporting; its refusal must not label
            // working budget reads and spend-table writes as disconnected.
            throw new Error(detail);
        }
    }
    async ensureReady() {
        if (this.usable)
            return;
        if (this.readyPromise)
            return this.readyPromise;
        this.readyPromise = this.connectAndCheckTools().finally(() => {
            this.readyPromise = null;
        });
        return this.readyPromise;
    }
    async connectAndCheckTools() {
        try {
            if (!this.connected) {
                await this.client.connect();
                this.connected = true;
            }
            if (!this.toolsChecked) {
                const listed = await this.client.listTools();
                const names = new Set(listed.tools.map((tool) => tool.name));
                this.toolSchemas.clear();
                for (const tool of listed.tools)
                    this.toolSchemas.set(tool.name, tool.inputSchema);
                for (const name of ['inspect_table_blocks', 'edit_table_blocks']) {
                    if (!names.has(name))
                        throw new Error(`cfo.ai MCP tool ${name} is missing`);
                }
                this.toolsChecked = true;
            }
            this.usable = true;
            this.setOkStatus();
        }
        catch (e) {
            this.statusState = { status: 'missing', detail: `${e.message}. ${CFOAI_FIX_COMMAND}` };
            throw e;
        }
    }
    async readUsd(row) {
        const result = await this.client.callTool('inspect_table_blocks', {
            ...this.scopeArgs(),
            read: { target: this.config.table, rows: [row], columns: [this.monthColumn()] },
        });
        return extractUsd(result, row, this.monthColumn());
    }
    async readUsdFrom(table, row) {
        const result = await this.client.callTool('inspect_table_blocks', {
            ...this.scopeArgs(),
            read: { target: table, rows: [row], columns: [this.monthColumn()] },
        });
        return extractUsd(result, row, this.monthColumn());
    }
    async loadBaseDetailSpend(mappedRows) {
        const entries = await Promise.all(mappedRows.map(async (row) => [row, usdToNanos(await this.readUsdFrom(this.config.spendDetailTable, row))]));
        const base = new Map(entries);
        const tierSum = [...base.values()].reduce((sum, value) => sum + value, 0);
        const agentSpend = this.runBaseSpendNanos ?? (await this.currentSpendNanos());
        const gap = agentSpend - tierSum;
        if (gap > 1 && mappedRows[0]) {
            base.set(mappedRows[0], (base.get(mappedRows[0]) ?? 0) + gap);
            this.seededDetailGapNanos = gap;
        }
        this.baseDetailSpendNanos = base;
    }
    async writeRows(table, rows) {
        const result = await this.client.callTool('edit_table_blocks', {
            ...this.scopeArgs(),
            update: {
                target: table,
                values: { columns: [this.monthColumn()], rows: [...rows].map(([row, nanos]) => [row, Number(nanosToUsd(nanos).toFixed(9))]) },
            },
        });
        if (!successfulEdit(result))
            throw new Error(`cfo.ai did not apply the ${table} update`);
    }
    async verifyRows(table, rows) {
        for (const [row, nanos] of rows) {
            const readBack = usdToNanos(await this.readUsdFrom(table, row));
            if (Math.abs(readBack - nanos) > 1)
                throw new Error(`cfo.ai ${table} read-back did not match ${row}`);
        }
    }
    async verifyAgentSpendMatchesTierRows(mappedRows, completeMapping) {
        if (!completeMapping)
            return;
        const [agentSpend, tierSpend] = await Promise.all([
            this.currentSpendNanos(),
            Promise.all(mappedRows.map((row) => this.readUsdFrom(this.config.spendDetailTable, row))),
        ]);
        const tierSum = tierSpend.reduce((sum, usd) => sum + usdToNanos(usd), 0);
        if (Math.abs(agentSpend - tierSum) > 1)
            throw new Error('cfo.ai Agent spend does not equal the sum of tier spend rows');
    }
    setOkStatus(note) {
        const links = [this.config.tableUrl, this.config.spendDetailTableUrl].filter(Boolean).join(' ');
        this.statusState = { status: 'ok', detail: [links || null, note].filter(Boolean).join(' ') || null };
    }
    monthColumn() {
        return cfoaiMonthColumn(this.now());
    }
    scopeArgs() {
        return {
            ...(this.config.orgId ? { org_id: this.config.orgId } : {}),
            ...(this.config.scenario ? { scenario: this.config.scenario } : {}),
        };
    }
}
function successfulEdit(value) {
    if (isRecord(value) && value.isError === true)
        return false;
    const parsed = unwrapToolResult(value);
    return isRecord(parsed) && (parsed.status === 'applied' || (parsed.status === 'no_op' && parsed.reason === 'already_satisfied'));
}
function cfoaiRefusalMessage(value) {
    const parsed = unwrapToolResult(value);
    let detail;
    if (typeof parsed === 'string')
        detail = parsed;
    else if (isRecord(parsed)) {
        const error = parsed.error;
        if (isRecord(error)) {
            detail = [error.code, error.message, error.hint].filter((part) => typeof part === 'string').join(': ');
        }
        else
            detail = parsed.message ?? error ?? parsed.reason ?? parsed.detail;
    }
    const safeDetail = typeof detail === 'string' ? safeCfoaiError(new Error(detail)) : null;
    return safeDetail && safeDetail !== 'cfo.ai returned an unspecified error'
        ? `cfo.ai refused the Ari context write: ${safeDetail}`
        : 'cfo.ai refused the Ari context write';
}
export function safeCfoaiError(error) {
    return (error instanceof Error ? error.message : String(error))
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
        .replace(/([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret|signature|code|password)=)[^&#\s]+/gi, '$1[redacted]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240) || 'cfo.ai returned an unspecified error';
}
function supportsOrganizationMemory(schema) {
    if (!schema)
        return false;
    try {
        const validate = new Ajv2020({ strict: false }).compile(schema);
        return validate({
            org_id: 'tally-workspace',
            idempotency_key: 'tally-doctor-schema-check',
            retain_document: {
                content: 'Schema check only. No cfo.ai memory write is made.',
                filename: 'tally-schema-check.md',
                scope: 'organization',
                tags: ['tally'],
                metadata: { producer: 'tally-agents' },
            },
        });
    }
    catch {
        return false;
    }
}
function extractUsd(value, row, column) {
    const parsed = unwrapToolResult(value);
    const tabular = findTabularNumber(parsed, row, column);
    if (tabular !== null)
        return tabular;
    const candidates = [
        isRecord(parsed) ? parsed.value : undefined,
        isRecord(parsed) ? parsed.values : undefined,
    ];
    for (const candidate of candidates) {
        const found = findNumber(candidate, row, column);
        if (found !== null)
            return found;
    }
    throw new Error(`cfo.ai response did not include ${row} / ${column}`);
}
function findNumber(value, row, column) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    if (Array.isArray(value)) {
        if (value.length >= 2 && value[0] === row) {
            const direct = findNumber(value[1], row, column);
            if (direct !== null)
                return direct;
        }
        for (const item of value) {
            const found = findNumber(item, row, column);
            if (found !== null)
                return found;
        }
    }
    if (isRecord(value)) {
        if (row in value) {
            const found = findNumber(value[row], row, column);
            if (found !== null)
                return found;
        }
        if (column in value) {
            const found = findNumber(value[column], row, column);
            if (found !== null)
                return found;
        }
        for (const item of Object.values(value)) {
            const found = findNumber(item, row, column);
            if (found !== null)
                return found;
        }
    }
    return null;
}
function findTabularNumber(value, row, column) {
    if (!isRecord(value) || !Array.isArray(value.rows))
        return null;
    const columns = Array.isArray(value.columns) ? value.columns : [];
    for (const candidate of value.rows) {
        if (!isRecord(candidate))
            continue;
        const displayName = typeof candidate.display_name === 'string' ? candidate.display_name : typeof candidate.name === 'string' ? candidate.name : null;
        if (displayName !== row)
            continue;
        const values = Array.isArray(candidate.values) ? candidate.values : [];
        const index = columnIndex(columns, column);
        const cell = values[index >= 0 ? index : 0];
        const direct = isRecord(cell) && 'value' in cell ? cell.value : cell;
        return exactNumber(direct);
    }
    return null;
}
function columnIndex(columns, column) {
    return columns.findIndex((candidate) => {
        if (!isRecord(candidate))
            return false;
        const ref = typeof candidate.ref === 'string' ? candidate.ref : '';
        const displayName = typeof candidate.display_name === 'string' ? candidate.display_name : '';
        return ref.startsWith(column) || displayName === column;
    });
}
function exactNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return null;
}
function unwrapToolResult(value) {
    if (isRecord(value)) {
        if ('structuredContent' in value)
            return value.structuredContent;
        if ('toolResult' in value)
            return value.toolResult;
        const content = value.content;
        if (Array.isArray(content)) {
            const text = content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
            if (isRecord(text) && typeof text.text === 'string') {
                try {
                    return JSON.parse(text.text);
                }
                catch {
                    return text.text;
                }
            }
        }
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function openInBrowser(url) {
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
function isCfoaiAuthError(error) {
    const seen = new Set();
    let current = error;
    while (current && !seen.has(current)) {
        seen.add(current);
        if (typeof current === 'object') {
            const value = current;
            if (value.status === 401 || value.statusCode === 401)
                return true;
            if (typeof value.name === 'string' && /unauthorized|oauth/i.test(value.name))
                return true;
            if (typeof value.message === 'string' && /\b(unauthori[sz]ed|authentication|auth(?:entication)? failed|invalid (?:access |refresh )?token|token expired)\b/i.test(value.message))
                return true;
            current = value.cause;
        }
        else {
            return typeof current === 'string' && /\b(unauthori[sz]ed|authentication|auth(?:entication)? failed|invalid (?:access |refresh )?token|token expired)\b/i.test(current);
        }
    }
    return false;
}
export async function loginCfoai(options = {}) {
    const normalized = normalizeCfoaiConfig(options.config);
    const tokenStore = new FileTokenStore(options.tokenPath);
    let resolveCode;
    let rejectCode;
    const code = new Promise((resolve, reject) => {
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
        }
        else {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('Missing OAuth code.\n');
            rejectCode(new Error('cfo.ai OAuth callback did not include a code'));
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('could not start local cfo.ai OAuth callback server');
    const redirect = `http://127.0.0.1:${address.port}/callback`;
    const openUrl = options.openUrl ?? openInBrowser;
    let provider = new CfoaiOAuthProvider(tokenStore, redirect, openUrl);
    let client = new SdkCfoaiMcpClient(normalized.serverUrl, provider);
    try {
        try {
            await client.connect();
        }
        catch (error) {
            if (provider.authorizationUrl) {
                // The SDK has already opened the browser; connect remains pending until the callback.
            }
            else if (tokenStore.read().tokens && isCfoaiAuthError(error)) {
                // A cached refresh/access token can be revoked while its OAuth client registration
                // remains valid. Retry without that token so the SDK starts a new browser flow.
                tokenStore.write({ ...tokenStore.read(), tokens: undefined });
                await client.close().catch(() => undefined);
                provider = new CfoaiOAuthProvider(tokenStore, redirect, openUrl);
                client = new SdkCfoaiMcpClient(normalized.serverUrl, provider);
                await client.connect().catch((retryError) => {
                    if (!provider.authorizationUrl)
                        throw retryError;
                });
            }
            else {
                throw error;
            }
        }
        if (!provider.authorizationUrl) {
            await client.listTools();
            await client.close();
            return { status: 'ok', tokenPath: tokenStore.tokenPath };
        }
        const timeout = new Promise((_, reject) => {
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
    }
    finally {
        server.close();
    }
}
export async function checkCfoaiConnection(options = {}) {
    const normalized = normalizeCfoaiConfig(options.config);
    const tokenStore = new FileTokenStore(options.tokenPath);
    if (!options.client && !tokenStore.read().tokens) {
        return { status: 'missing', detail: `Tally has no cached cfo.ai token. ${CFOAI_FIX_COMMAND}` };
    }
    const client = options.client ??
        new SdkCfoaiMcpClient(normalized.serverUrl, new CfoaiOAuthProvider(tokenStore, undefined, async () => undefined));
    try {
        await client.connect();
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        for (const name of ['inspect_table_blocks', 'edit_table_blocks']) {
            if (!names.has(name))
                throw new Error(`cfo.ai MCP tool ${name} is missing`);
        }
        if (options.config?.publishRunContext) {
            const memory = listed.tools.find(tool => tool.name === 'edit_memory');
            if (!supportsOrganizationMemory(memory?.inputSchema))
                throw new Error('cfo.ai organization memory is enabled in tally.yaml, but edit_memory does not support the required organization-scoped document schema');
        }
        await client.close();
        return { status: 'ok', detail: `Tally cached token works against ${normalized.serverUrl}` };
    }
    catch (e) {
        try {
            await client.close();
        }
        catch {
            // The connection was not open.
        }
        return { status: 'missing', detail: `${safeCfoaiError(e)}. ${CFOAI_FIX_COMMAND}` };
    }
}
//# sourceMappingURL=cfoai.js.map