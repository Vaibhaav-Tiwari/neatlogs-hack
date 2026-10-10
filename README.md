# Tally

A CFO for a fleet of coding agents. Give it a backlog and a budget. It sizes
each task, sends it to the cheapest model likely to finish it, stops any task
that overruns its spend ceiling, hands failed work to a stronger model, and
ends with a ledger tying every dollar to a merged PR.

Status: early build. The shared data contract exists, `tally demo` runs the
seven-task simulated demo backlog, and `tally run --dry-run` writes run state
plus a ledger from a file-backed backlog. The real AO worker path is wired and
ready for a gated one-task smoke run.

## Install

Prerequisites before you install:

- Node 20 or later.
- Agent Orchestrator installed and running.
- At least one signed-in coding agent that Agent Orchestrator can start.
- GitHub CLI installed and signed in with `gh auth login`.

Three ways in:

```bash
npm install -g github:Vaibhaav-Tiwari/neatlogs-hack
npm install -g tally-agents
git clone https://github.com/Vaibhaav-Tiwari/neatlogs-hack && cd neatlogs-hack && npm install && npm run build
```

The npm package is named `tally-agents`; the installed command is still
`tally`.

## Quickstart

Needs Node 20 or later.

```bash
npm install
npm run build
npm run tally -- demo --dashboard
npm run tally -- demo --live --dashboard
npm run tally -- dashboard
npm run tally -- doctor --config demo/tally.yaml
npm run tally -- run --dry-run --plan --config demo/tally.yaml
npm run tally -- login cfoai
npm run tally -- market --limit 5
```

The first two commands install and compile Tally. The remaining commands show
the full fake-worker demo, the read-only live-integration demo, the standalone
dashboard, integration checks, a dry-run plan, cfo.ai login, and the CrustData
market search. Run them one at a time; dashboard commands keep serving until
you stop them. Commands that call external services report the missing login or
API key instead of printing secrets. During development, `npm run tally --
<command>` runs the CLI from source. After `npm run build`,
`node bin/tally.js <command>` runs the compiled package entry.

For routine validation, run:

```bash
npm test
```

## Commands

| Command | What it will do |
|---|---|
| `tally run` | Run the backlog against the budget in `tally.yaml`. Flags: `--dry-run`, `--budget <usd>`, `--only <task>`, `--baseline`, `--config <path>`, `--plan`, `--dashboard`/`--open`. |
| `tally demo` | Run the full loop with simulated workers on `demo/tally.yaml` and `demo/sample-backlog.yaml`. No accounts or keys. Writes `.tally/runs/<run-id>/run.json` and `ledger.json`; add `--dashboard` for the one-command demo, or `--live` to light up read-only integrations while workers stay fake. |
| `tally dashboard` | Serve `dashboard/` and `.tally/runs/` read-only on `127.0.0.1`. The printed URL passes `?data=/runs/latest/` so the page reads the stable latest-run mirror. |
| `tally init` | Detect the test command, ask for a budget and issue label, and write `tally.yaml`. |
| `tally doctor` | One line per integration: connected, missing or broken, with the fix. |

## Layout

| Folder | Holds |
|---|---|
| `schema/` | The contract every part reads: TypeScript types, JSON Schema, validators, and a sample finished run in `schema/fixtures/finished-run/`. |
| `engine/` | The run loop, run state and ledger. |
| `adapters/` | One thin module per outside tool (Agent Orchestrator, Entire, neatlogs, cfo.ai, GitHub). |
| `agent/` | The CFO agent: sizing, routing, ceilings, escalation. |
| `cli/` | The `tally` command. |
| `dashboard/` | Static page that reads the ledger and run state. |
| `demo/` | Sample backlog and scripted outcomes for `tally demo`. |

## Configuration

Tally assumes nothing about the repository it works on. The repository, test
command, model tiers, list prices, ceilings and budget all come from
`tally.yaml` (a tier is a name, harness, model id, provider, list price and ceiling share); see `schema/fixtures/finished-run/tally.yaml` for a complete
example and `schema/tally-config.schema.json` for the rules.

Money in the ledger and run state is stored as integer nanos of USD
(1 USD = 1,000,000,000). Cost is always tokens multiplied by the list price in
`tally.yaml`.

For dry runs, set `backlog.source: file` and point `backlog.file` at YAML like:

```yaml
tasks:
  - id: T1
    title: Add validation for empty player name
    size: small
    outcomes: [passed]
  - id: T2
    title: Persist settings after restart
    size: medium
    outcomes: [stopped, passed]
```

`outcomes` is optional and defaults to one passed simulated attempt.

The latest run is also mirrored to `.tally/runs/latest/run.json` and
`.tally/runs/latest/ledger.json` so the dashboard has one stable path to poll.

## Secrets

Keys live in `~/.tally/.env`, outside every repository, and are loaded from
there. Never put them in this repo; `.env` files are git-ignored.
