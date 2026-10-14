import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { IntegrationState } from '../schema/types.js';
import type { BudgetPort } from '../agent/ports.js';
import type { CfoaiTaskContextDocument } from './cfoai-context.js';
export declare const CFOAI_SERVER_URL = "https://api.cfo.ai/mcp";
export declare const CFOAI_FIX_COMMAND = "Run `tally login cfoai` to connect cfo.ai.";
export interface CfoaiBudgetConfig {
    orgId?: string;
    scenario?: string;
    pageName?: string;
    table?: string;
    budgetRow?: string;
    spendRow?: string;
    remainingRow?: string;
    spendDetailTable?: string;
    spendDetailTableUrl?: string;
    publishRunContext?: boolean;
    tierSpendRows?: Record<string, string>;
    runSpendRow?: string;
    cumulativeRunSpendRow?: string;
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
    spendDetailTable: string;
    spendDetailTableUrl?: string;
    tierSpendRows: Record<string, string>;
    runSpendRow: string;
    cumulativeRunSpendRow: string;
    tableUrl?: string;
    serverUrl: string;
}
export interface CfoaiMcpClient {
    connect(): Promise<void>;
    listTools(): Promise<{
        tools: {
            name: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
        }[];
    }>;
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
export interface CfoaiSpendDetailInput {
    attempts: Array<{
        tier: string;
        costNanos: number;
    }>;
    cumulativeRunSpendNanos: number;
}
export interface CfoaiSpendDetailResult {
    skippedTiers: string[];
}
export declare function defaultCfoaiTokenPath(): string;
export declare function normalizeCfoaiConfig(config: CfoaiBudgetConfig | undefined): NormalizedCfoaiBudgetConfig;
export declare function cfoaiMonthColumn(date?: Date): string;
export declare function refreshTokenRequest(tokens: OAuthTokens | undefined, scope?: string): URLSearchParams | undefined;
/** A separate MCP connection using only Tally's own OAuth cache. */
export declare function createCfoaiClient(tokenPath?: string): CfoaiMcpClient;
export interface CfoaiBudgetAdapterOptions {
    config?: CfoaiBudgetConfig;
    client?: CfoaiMcpClient;
    now?: () => Date;
}
export declare class CfoaiBudgetAdapter implements BudgetPort {
    private readonly config;
    private readonly now;
    private connected;
    private usable;
    private statusState;
    private toolsChecked;
    private runBaseSpendNanos;
    private baseDetailSpendNanos;
    private seededDetailGapNanos;
    private readyPromise;
    private readonly toolSchemas;
    constructor(options?: CfoaiBudgetAdapterOptions);
    private readonly client;
    status(): IntegrationState;
    tableUrl(): string | undefined;
    spendDetailTableUrl(): string | undefined;
    budgetLimitNanos(): Promise<number>;
    currentSpendNanos(): Promise<number>;
    remainingNanos(): Promise<number>;
    close(): Promise<void>;
    writeCumulativeActualSpend(runSpendNanos: number): Promise<void>;
    writeSpendDetail(input: CfoaiSpendDetailInput): Promise<CfoaiSpendDetailResult>;
    publishTaskContext(document: CfoaiTaskContextDocument): Promise<void>;
    private ensureReady;
    private connectAndCheckTools;
    private readUsd;
    private readUsdFrom;
    private loadBaseDetailSpend;
    private writeRows;
    private verifyRows;
    private verifyAgentSpendMatchesTierRows;
    private setOkStatus;
    private monthColumn;
    private scopeArgs;
}
export declare function safeCfoaiError(error: unknown): string;
export declare function loginCfoai(options?: {
    config?: CfoaiBudgetConfig;
    tokenPath?: string;
    openUrl?: (url: URL) => Promise<void>;
    timeoutMs?: number;
}): Promise<CfoaiLoginResult>;
export declare function checkCfoaiConnection(options?: CfoaiConnectionCheckOptions): Promise<IntegrationState>;
