/**
 * The shared contract between the engine, the CFO agent and the dashboard.
 *
 * Every type here has a matching JSON Schema in this folder
 * (`*.schema.json`). Change both together and bump SCHEMA_VERSION when a
 * change is not backwards compatible.
 *
 * Money is stored as integer nanos of USD (1 USD = 1_000_000_000), the unit
 * the Agent Orchestrator usage endpoint reports. Config files use plain USD.
 */

export const SCHEMA_VERSION = 1;

export type TaskSize = 'small' | 'medium' | 'large';

/** Outcome of one attempt. `stopped` means the watcher killed it at its ceiling. */
export type AttemptResult = 'passed' | 'failed' | 'stopped' | 'error';

/** How the cost on a row was obtained. */
export type CostSource =
  /** tokens x list price from tally.yaml (the default, comparable across harnesses) */
  | 'list-price'
  /** the Agent Orchestrator's own estimate, used only when no list price is configured */
  | 'ao-estimate'
  /** a dry-run or demo attempt that spent nothing */
  | 'simulated';

/** How an escalated attempt received the earlier attempt's work. */
export type Handoff = 'none' | 'restart' | 'entire-handoff';

export interface TokenUsage {
  /** Input tokens billed at the full input price. Includes cache writes. */
  uncachedInput: number;
  /** Input tokens read from cache. */
  cachedInput: number;
  output: number;
  /** uncachedInput + cachedInput + output */
  total: number;
}

/** One row per attempt. A task that escalates has two rows. */
export interface LedgerRow {
  schemaVersion: 1;
  /** `${runId}:${taskId}:${attempt}` */
  attemptId: string;
  runId: string;
  taskId: string;
  taskTitle: string;
  /** 1 for the first attempt, 2 for the escalation. */
  attempt: number;
  size: TaskSize;
  /** Name of the tier in tally.yaml that ran this attempt. */
  tier: string;
  model: string;
  harness: string;
  /** Agent Orchestrator session id; null for simulated attempts. */
  sessionId: string | null;
  branch: string | null;
  tokens: TokenUsage;
  estimatedCostNanos: number;
  costSource: CostSource;
  /** Spend ceiling that applied to this attempt. */
  ceilingNanos: number;
  result: AttemptResult;
  /** Short explanation of the result, e.g. "2 tests failing" or "ceiling crossed". */
  resultReason: string | null;
  scopeWarnings?: string[];
  /** attemptId of the attempt this one took over from, if it is an escalation. */
  escalatedFrom: string | null;
  handoff: Handoff;
  prUrl: string | null;
  /** Neatlogs trace id for the routing or escalation decision that created this attempt. */
  traceId: string | null;
  traceUrl: string | null;
  checkpointId: string | null;
  checkpointUrl: string | null;
  /** The CFO agent's one-sentence reason for choosing this tier. */
  decision: string;
  startedAt: string;
  endedAt: string | null;
}

export type Ledger = LedgerRow[];

export type RunMode = 'tally' | 'baseline';
export type RunStatus = 'running' | 'finished' | 'interrupted';
export type TaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type BudgetSource = 'config' | 'cfoai';

export type IntegrationName = 'neatlogs' | 'entire' | 'cfoai' | 'github' | 'slack';
/** `off` = switched off in config, `missing` = on but not usable, `error` = failed during the run. */
export type IntegrationStatus = 'ok' | 'off' | 'missing' | 'error';

export interface IntegrationState {
  status: IntegrationStatus;
  /** What Tally does instead, or what went wrong. */
  detail: string | null;
}

export interface TaskState {
  taskId: string;
  title: string;
  issueNumber: number | null;
  issueUrl: string | null;
  /** null until the sizer has run. */
  size: TaskSize | null;
  status: TaskStatus;
  /** Why a task is failed or skipped, e.g. "not started: no budget". */
  statusReason: string | null;
  attempts: number;
  /** Tier of the latest attempt. */
  tier: string | null;
  model: string | null;
  spentNanos: number;
  escalated: boolean;
  prUrl: string | null;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  mode: RunMode;
  /** True when workers were simulated and nothing was spent. */
  dryRun: boolean;
  status: RunStatus;
  /** The repository the run worked on, as written in tally.yaml. */
  repo: string;
  /** Commit every task branched from. */
  baseCommit: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  budget: {
    source: BudgetSource;
    limitNanos: number;
    /** Always the sum of estimatedCostNanos over this run's ledger rows. */
    spentNanos: number;
  };
  tasks: TaskState[];
  integrations: Record<IntegrationName, IntegrationState>;
}

export interface TierPrice {
  inputUsdPerMTok: number;
  cachedInputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface Tier {
  /** Free-form label, e.g. cheap / middle / top. Referenced by ledger rows. */
  name: string;
  /** Any harness the Agent Orchestrator supports. */
  harness: string;
  /** AO session interface for real workers. TUI is required for unattended shell work. */
  sessionMode?: 'chat' | 'tui';
  /** Model id as the provider names it, e.g. a gateway alias such as nova-lite. */
  model: string;
  /** Who serves and bills the model, e.g. anthropic, openai, litellm, bedrock. */
  provider: string;
  /** Published list price. Cost is always tokens x this. */
  price: TierPrice;
  /** Share of the size ceiling this tier may spend, in (0, 1]. */
  ceilingFraction: number;
}

export interface TallyConfig {
  version: 1;
  repo: {
    /** Local checkout, relative to tally.yaml. */
    path: string;
    /** owner/name on GitHub, when issues or PRs are used. */
    slug?: string;
    baseBranch: string;
    /** Agent Orchestrator project id, when it differs from the default for the checkout. */
    aoProject?: string;
    /** Let the worker push/open its own PR. Defaults to false; Tally publishes after verification. */
    workerPublishesPr?: boolean;
    blockOutOfScopeChanges?: boolean;
  };
  test: {
    /** Run in the task's checkout; exit code 0 means the task passed. */
    command: string;
    /** Run once per fresh checkout before the test command. */
    setupCommand?: string;
    timeoutSec?: number;
  };
  backlog: {
    source: 'github-issues' | 'file';
    issueLabel?: string;
    /** YAML backlog file, relative to tally.yaml. */
    file?: string;
  };
  /** Ordered from cheapest to strongest. Escalation moves one step right. */
  tiers: Tier[];
  ceilings: {
    /** What the strongest tier may spend on a task of each size, in USD. */
    bySizeUsd: Record<TaskSize, number>;
  };
  budget: {
    source: BudgetSource;
    /** The budget, or the fallback when the cfo.ai scenario cannot be read. */
    usd: number;
    cfoai?: {
      /** cfo.ai org/workspace id, e.g. "<cfoai-org-id>". */
      orgId?: string;
      scenario?: string;
      table?: string;
      budgetRow?: string;
      spendRow?: string;
      remainingRow?: string;
      spendDetailTable?: string;
      spendDetailTableUrl?: string;
      tierSpendRows?: Record<string, string>;
      runSpendRow?: string;
      cumulativeRunSpendRow?: string;
      tableUrl?: string;
      serverUrl?: string;
    };
  };
  concurrency?: number;
  integrations: Record<'neatlogs' | 'entire' | 'cfoai' | 'slack', boolean>;
}
