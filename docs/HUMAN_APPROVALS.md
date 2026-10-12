# Human approval points

Tally keeps account access, data capture, repository changes, and paid work behind separate choices. A successful `tally doctor` check proves a connection is reachable; it does not approve hooks, capture, table creation, or a worker run.

## Setup choices

### `tally init`

Review the final proposal before answering `Apply these changes?`. It shows the repository and base branch, tests and setup commands, models, budget, runner, integrations, and files/configuration to be written. This last confirmation writes `tally.yaml` and `.tally/install.json`; AO setup, when selected, also changes the named AO project settings. Setup and test commands execute repository code and can install dependencies.

The integration table is a selection summary, not proof that each integration is fully ready. The following steps have their own consent:

- **Neatlogs project key:** `NEATLOGS_API_KEY` authorizes decision-trace export. A consented SDK probe sends synthetic probe spans. Tally stores credentials outside the repository. This key does not grant Public API history reads.
- **Neatlogs history read:** selecting a project and saving a service-account token enables read-only history lookups. Use a project-scoped token with `context:read` for project discovery and `observability:read` for traces and spans. Tally uses the Public API's bearer token, `x-project-id`, and cursor pagination; it does not write history records remotely through this reader. See Neatlogs' [authentication and scopes](https://docs.neatlogs.com/api-reference/authentication) and [pagination contract](https://docs.neatlogs.com/api-reference/pagination).
- **Global Neatlogs hooks:** the separate global-hook prompt installs packages globally and changes `~/.claude/settings.json` and `~/.codex/hooks.json`. These hooks can observe coding-agent sessions outside Tally, so approve only if machine-wide tracing is intended and allowed for the data on this machine. In Codex, open `/hooks`, inspect the exact Neatlogs hook definitions, and trust them yourself. Tally cannot grant that trust.
- **Entire login and Graph plugin:** approving login starts Entire's own browser authentication; approving Graph installs its CLI plugin. These are account/machine changes and are independent of Tally's final config write.
- **Entire repository capture:** before enabling capture, review the proposed repository files and local Git hooks. A second confirmation is required before Tally commits only the listed settings and pushes them to the repository's default branch. That push is a GitHub write and can enable checkpoint/session evidence for future workers. Declining publication leaves capture unavailable to worker worktrees until you publish the settings through your normal review process.
- **Entire Codex hooks:** after repository capture is published, open Codex in that repository, run `/hooks`, inspect the Entire hooks, and trust them yourself. If you decline or have not trusted them, init keeps Entire disabled. Tally cannot approve hooks on your behalf. See the [Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks).
- **cfo.ai login and selection:** approving connection starts cfo.ai's OAuth flow in a browser. Select the intended workspace and scenario; these determine which organization's monthly budget and spend tables Tally reads and updates.
- **cfo.ai table creation:** if required tables are missing, Tally displays their names, rows, formulas, and starting values, then asks before creating them. Existing tables and model data are not reset. Table creation is an external cfo.ai write.

## Before each run

- `tally doctor` checks configured connections. It does not start workers, trust hooks, create tables, or publish repository settings.
- `neatlogs key: connected` means the ingest key is configured; it does not prove that `NEATLOGS_TOKEN` can read the selected project's history. In a plan, `History source: remote Neatlogs` confirms a matching remote observation. `local Neatlogs fallback` means Tally used local observations; if neither source has usable data, the plan shows `none` and may include a `History note`.
- `tally run --plan` reads the selected GitHub backlog, local repository signals, Neatlogs history when enabled, and CFO.ai budget/spend when enabled. It starts no coding agent, writes no CFO.ai spend, and creates no PR. Neatlogs history reads have a 15-second total deadline; if that read fails or times out, Tally reports the fallback and uses local history.
- `tally run --dry-run` uses simulated workers and does not make paid model calls or write simulated spend to CFO.ai. It is not offline: when Neatlogs is enabled, route-decision traces may still be sent remotely. Use `--plan` for a no-worker, read-only preflight; it reads enabled services but does not export decision traces.
- `tally demo --live` also uses simulated workers and does not write simulated CFO.ai spend, but it may export route-decision traces to Neatlogs when enabled. Treat that as a remote trace write, not a read-only demo.
- **`tally run` is the approval to perform real work.** It starts the configured coding agent, uses the model account, edits a worker worktree, runs the configured verification command, and can publish a PR after verification. With cfo.ai enabled, real usage is written to the selected spend tables; if a write fails, Tally keeps a local CSV fallback. Review the task list and effective available budget before starting.
- The run cap and CFO.ai monthly remainder are both applied. `--budget` only tightens the available amount. Spend monitoring depends on usage reported by the harness/provider; it is not a provider-side billing limit, so set a conservative cap and retain the provider's own billing controls.
- If CFO.ai cannot be read, a preview labels that it is using `tally.yaml`'s fallback. A real run configured with a cfo.ai budget may use its explicit local fallback when the service is unreachable; that run cannot enforce the live account remainder. Restore the cfo.ai connection before starting if the live budget is the required source of truth.

## What the current onboarding transcript still requires

If init says Codex hooks are not trusted, the manual `/hooks` review is still required even when the hook files were created and pushed. If you skip it, Tally intentionally keeps the associated integration off. A config flag or `doctor` result cannot replace that human decision.
