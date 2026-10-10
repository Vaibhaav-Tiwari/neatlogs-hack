# Tally

A CFO for a fleet of coding agents. Give it a backlog and a budget. It sizes
each task, sends it to the cheapest model likely to finish it, stops any task
that overruns its spend ceiling, hands failed work to a stronger model, and
ends with a ledger tying every dollar to a merged PR.

Status: early build, available from GitHub. The npm package `tally-agents`
has not been released yet. The seven-task demo uses simulated workers; real
runs use Agent Orchestrator and record their attempts and evidence separately.

## Install

Prerequisites before you install:

- Node 20 or later and npm.
- For real runs: Agent Orchestrator installed and running, with at least one
  signed-in coding agent it can start.
- For real runs: GitHub CLI installed and signed in with `gh auth login`.

The simulated demo and dashboard need only Node and npm. They do not need an
AO account, coding-agent login or GitHub credentials.

Three ways in:

1. **GitHub (available now):** `npm install -g github:Vaibhaav-Tiwari/neatlogs-hack`.
   Installation builds the CLI automatically.
2. **npm (not released yet):** after release, `npm install -g tally-agents`.
3. **Source checkout:** `git clone https://github.com/Vaibhaav-Tiwari/neatlogs-hack`,
   enter `neatlogs-hack`, and run `npm install`.
   Then use `node bin/tally.js` in place of `tally` in the commands below.
   `npm install` builds the CLI through its prepare script.

The npm package is named `tally-agents`; the installed command is still
`tally`.

## Quickstart

After either global installation, start in an empty directory:

```bash
tally demo
tally dashboard
```

The demo writes `.tally/runs/` in that directory. Open the URL printed by
`tally dashboard`; it reads the latest run and lists recorded runs. Keep it
running while viewing the page, and press Ctrl-C to stop it. If its default
port is occupied, use `tally dashboard --port 0` for a free port.

`tally demo --live` keeps workers simulated while checking the configured
read-only integrations. Bundled cfo.ai workspace/table values are placeholders;
missing credentials are reported, and no real worker is launched.

### A Provided Tarball

With only a packed `tally-agents-0.1.0.tgz` in your current directory, these
commands install into a temporary prefix without changing your normal global
installation, then follow the same quickstart:

```bash
npm install -g --prefix "$PWD/tally-install" ./tally-agents-0.1.0.tgz
export PATH="$PWD/tally-install/bin:$PATH"
tally demo
tally dashboard --port 0
```

No checkout, manual build or `tally init` is needed for the demo.

### Your Repository

Run `tally init` from the repository you want Tally to work on. It asks for
budget and issue label; neatlogs, Entire and cfo.ai are separate opt-in prompts,
defaulting to No. It displays the proposed `tally.yaml`, install record in
`.tally/`, AO project registration/configuration and setup hook, then asks for
final confirmation (default No) before applying changes. Use `tally init
--dry-run` to preview without applying, or `--yes` only when you consent to
applying detected defaults without prompts. Review model tiers, prices, tests
and ceilings before starting workers. Scoped worker allow-list enforcement is
not yet installed; init does not change global coding-agent settings.

Use `tally doctor`, then `tally run --plan` to inspect routing without spawning
workers. A real `tally run` starts workers and can publish verified branches
and pull requests. `tally run --dry-run` uses simulated workers instead.

`tally uninstall` lists the files and AO settings it owns and asks for
confirmation before removing them. It refuses to overwrite edits made since
init. It leaves run history, credentials and the globally installed CLI in
place; remove that CLI separately with `npm uninstall -g tally-agents`.

### Static Snapshot

`tally publish --out site` writes a self-contained static dashboard,
defaulting to real recorded runs. Select folders explicitly with
`tally publish --out site --runs run-id-1,run-id-2`; use this for simulated demo
data. It scans exported files for sensitive content and prints file sizes and
the total. Serve the directory on a static HTTP host, including under a
sub-path. This creates local files and does not deploy them.

During development, `npm run tally -- <command>` runs the CLI from source.

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
| `tally init` | Preview files and AO changes, then ask final default-No consent. `--dry-run` previews; `--yes` applies defaults without prompts. Scoped worker allow-list enforcement is not yet installed. |
| `tally uninstall` | Confirm removal of init-owned configuration and AO settings; preserve history and credentials. |
| `tally doctor` | One line per integration: connected, missing or broken, with the fix. |
| `tally login cfoai` | Sign in to cfo.ai; tokens are cached outside the repository. |
| `tally market --limit 5` | Search CrustData for companies adopting coding agents; requires its credentials. |
| `tally publish --out site` | Static dashboard export with a sensitive-content scan. No deployment. |

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

With `integrations.entire: true`, enable Entire in the target repository and
trust its Codex hooks through `/hooks` before starting workers. Tally records
the task commit's `Entire-Checkpoint` trailer and its native `entireSessionId`
separately from the AO `sessionId`. Logs-only checkpoints retain conversation
context; escalation defaults to a metadata-only handoff containing the
checkpoint/session IDs, branch, recorded and changed files, attempt verdict,
and task text. It does not generate a summary or export a transcript.
`entire.generatedSummaries: true` explicitly opts into Entire's summary
provider (`checkpoint explain --generate`), which may export session content;
this setting is off by default and requires the user's approval.
When Tally publishes a verified branch, it also pushes the checkpoint refs
named by its new commits to `origin` and to an `entire` remote when configured.
Checkpoint upload failures are reported as publishing failures. Dry runs do
not publish branches or checkpoints.

Entire documents commit links as
`https://entire.io/gh/<org>/<repo>/commit/<commit-sha>`. Tally keeps
`checkpointUrl` null unless the CLI returns a URL; a local checkpoint does not
by itself establish that a hosted link works.

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
