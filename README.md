# Tally

A CFO for a fleet of coding agents. Give it a backlog and a budget. It sizes
each task, sends it to the cheapest model likely to finish it, stops any task
that overruns its spend ceiling, hands failed work to a stronger model, and
ends with a ledger tying every dollar to a merged PR.

Status: early scaffold. The shared data contract and the CLI entry point
exist; the commands are stubs.

## Setup

Needs Node 20 or later.

```bash
npm install
npm test          # unit tests
npm run build     # compile to dist/
node bin/tally.js --help
```

During development, `npm run tally -- <command>` runs the CLI from source.

## Commands

| Command | What it will do |
|---|---|
| `tally run` | Run the backlog against the budget in `tally.yaml`. Flags: `--dry-run`, `--budget <usd>`, `--only <task>`, `--baseline`, `--config <path>`. |
| `tally demo` | Run the full loop with simulated workers on a sample backlog. No accounts or keys. |
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
`tally.yaml`; see `schema/fixtures/finished-run/tally.yaml` for a complete
example and `schema/tally-config.schema.json` for the rules.

Money in the ledger and run state is stored as integer nanos of USD
(1 USD = 1,000,000,000). Cost is always tokens multiplied by the list price in
`tally.yaml`.

## Secrets

Keys live in `~/.tally/.env`, outside every repository, and are loaded from
there. Never put them in this repo; `.env` files are git-ignored.
