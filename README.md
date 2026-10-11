# Tally

A CFO for a fleet of coding agents. Give it a backlog and a budget. It sizes
each task, sends it to the cheapest model likely to finish it, stops any task
that overruns its spend ceiling, hands failed work to a stronger model, and
ends with a ledger tying spend to each attempt, its test result and any opened PR.

Status: early build, available from GitHub. The npm package `tally-agents`
has not been released yet. The seven-task demo uses simulated workers; real
runs use Agent Orchestrator by default, or the headless Claude direct runner,
and record their attempts and evidence separately.

## Install

Prerequisites before you install:

- Node 20 or later and npm.
- Git, for installing from GitHub or from a source checkout.

That is all the simulated demo and the dashboard need. They use no Agent
Orchestrator account, coding-agent login or GitHub credentials.

A real run on your own repository also needs, today:

- **Agent Orchestrator (AO), installed and running**, for the default `runner: ao`.
  Alternatively, set `runner: direct` in `tally.yaml` with Claude-only tiers;
  Tally creates worktrees and starts `claude -p` itself, without an AO daemon.
  Codex direct is not supported yet; Tally never substitutes a harness.
- At least one coding agent that AO can start, installed and signed in: Codex
  or Claude Code. `tally init` proposes model tiers only for the agents it
  finds installed.
- GitHub CLI, signed in with `gh auth login`, with access to the repository.
  Tally reads issues and opens pull requests through it.
- A test command for the repository that exits 0 when the work is good. Tally
  accepts a task only when that command passes, so `tally init` writes no
  configuration without one.

neatlogs, Entire and cfo.ai are optional. Each is off unless you turn it on
during `tally init`, and the dashboard shows which are on, off or broken.
With Entire off or unavailable, sizing uses named paths and bounded identifier
searches in tracked repository files. It counts explicit new files and nearby
tests without claiming graph dependencies. Specific target evidence increases
confidence; ambiguous or truncated searches remain cautious. `run --plan`
prints the size, confidence, route and ceiling without starting a worker.

### Headless Claude Runner

`runner: direct` needs Claude Code installed on PATH and signed in with
`claude auth login`. Keep each tier's `harness: claude-code` and explicit model;
the usual test command, list prices, budgets and integrations still apply.
`claudeCode.allow` must contain the tool rules consented to in `tally init`;
Tally passes that list verbatim and refuses to launch Claude without it.
Direct workers use scoped file-edit and git/test/setup allow rules with
`--permission-mode dontAsk`, never bypass-permissions. Push and `gh` are denied
to workers; Tally verifies and publishes. Setup runs in the new worktree before
the agent starts and is recorded separately as `setupDurationMs`.

The live meter reads [Claude's partial stream events](https://code.claude.com/docs/en/agent-sdk/streaming-output)
and deduplicates API message ids; final JSON usage settles the same session,
not an additional charge. Usage arrives at message boundaries, so a ceiling
can overshoot during a long generation or between watcher polls. Prompt-cache
writes use [Anthropic's 5-minute / 1-hour multipliers](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
of 1.25x / 2x the configured input price. Existing ledger costs are unchanged.
Subagents and MCP tools are disabled so their unmetered work cannot escape the
task ceiling. These are harness permission rules, not an OS isolation guarantee;
configured commands and installed hooks must be trusted. Entire and neatlogs
hooks are retained (no bare mode); their real headless capture is not yet proven.
Published worktrees are removed; stopped/failed checkouts stay available for
handoff or recovery. A live direct process cannot be reattached after Tally exits.

Three ways in:

1. **GitHub (available now):** `npm install -g github:Vaibhaav-Tiwari/neatlogs-hack#release`.
   The `release` branch includes the compiled CLI and records its source commit
   in `release-source.json`; no TypeScript or manual build is needed. The main
   branch is source-only and is not the global-install target.
2. **npm (not released yet):** after release, `npm install -g tally-agents`.
3. **Source checkout:** `git clone https://github.com/Vaibhaav-Tiwari/neatlogs-hack`,
   enter `neatlogs-hack`, and run `npm install` followed by `npm run build`.
   Then use `node bin/tally.js` in place of `tally` in the commands below.
   After editing TypeScript sources, run `npm run build` again. Generated
   `dist/` files are not committed to main.

The npm package is named `tally-agents`; the installed command is still
`tally`.

Maintainers can build a release tree with
`npm run release:branch -- --source origin/main --out /tmp/tally-release`.
Add `--push` to update the dedicated `release` branch (never publishes to npm).
The main-push workflow builds and smoke-checks that tree before updating it.
`npm run test:git-install` checks the GitHub `#release` URL with an empty cache
and temporary global prefix, then checks version, help, demo and dashboard
outside the checkout. Pass another Git URL after `--` to check a candidate.

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

### First Run On Your Own Repo

Check the prerequisites for a real run above first. Then, from the root of the
repository you want Tally to work on:

1. **Label the issues Tally should take.** Tally reads open issues that carry
   one label (`tally` unless you choose another). The label must exist and be
   on at least one open issue:

   ```bash
   gh label create tally --description "Work for Tally"
   gh issue edit 12 --add-label tally
   gh issue list --label tally --state open
   ```

   The last command is the query Tally makes. If it prints nothing, Tally has
   no tasks to work on.
2. **`tally init`** asks for a budget and the issue label, shows the
   short configuration summary and the AO changes it would make, and applies
   nothing until you confirm. Type the label exactly as it is on GitHub.
3. **`tally doctor`** prints one line per integration: connected, missing or
   broken, with the fix.
4. **`tally run --plan`** lists the tasks it found and the model each would go
   to. It starts no workers and spends nothing. Check the task count here
   before going further.
5. **`tally run`** starts real workers through AO. It spends against your
   agent accounts and can push branches and open pull requests on the
   repository.
6. **`tally dashboard`**, in a second terminal in the same directory, prints a
   local URL showing the run as it happens.

More on `tally init`: neatlogs, Entire and cfo.ai are separate opt-in prompts,
defaulting to No. It displays a compact proposal (full YAML with `--verbose`), install record in
`.tally/`, AO project registration/configuration and setup hook, then asks for
final confirmation (default No) before applying changes. Use `tally init
--dry-run` to preview without applying, or `--yes` only when you consent to
applying detected defaults without prompts. Review model tiers, prices, tests
and ceilings before starting workers. Scoped worker allow-list enforcement is
not yet installed; init does not change global coding-agent settings.
The final summary explicitly includes automatic safety review for this AO
project's workers only. Uninstall restores that owned setting; it never
enables bypass-permissions.

Interactive init requires a terminal. Piped input exits with a plain message
instead of waiting for answers. For scripted onboarding, pass values explicitly:

```sh
tally init --yes --test-command "node --check js/app.js" \
  --setup-command "" --budget 5 --issue-label tally \
  --neatlogs yes --entire no --cfoai yes
```

An empty setup flag means no setup. Product flags select integrations, not
optional browser login, SDK probes, global hooks or remote table writes.
Existing credentials and cfo.ai tables can be discovered read-only; absent
prerequisites are reported. Declining optional neatlogs probes/read access/hooks
keeps tracing enabled when a project key is already configured.

Init detects test/setup commands from repository evidence and proposes tiers
only for installed Codex or Claude Code agents. When no test command is found,
it asks for a shell command: Tally cannot verify work without one. Blank input
or `--yes` without either a detected command or `--test-command` fails without writing configuration
or changing AO settings. An undetected setup command is optional and never
guessed.

AO does not need to be on your ordinary terminal's PATH. Tally resolves the
CLI from PATH first, then `TALLY_AO_BIN`, then `repo.aoBin` in `tally.yaml`
(relative to that file), then the macOS Agent Orchestrator app bundle under
`/Applications` or `~/Applications`. For a custom installation:

```bash
export TALLY_AO_BIN="/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao"
tally init
```

Doctor and real runs use the same resolver. Init checks AO, git, GitHub auth
and requested integrations before applying changes. An Entire opt-in requires
Entire to be enabled in the target repo; init prints `entire enable` and stops
if it is not, rather than installing capture hooks without consent.

Once confirmed, init records progress in `.tally/init-pending.json`. If an AO
or file operation fails, it lists confirmed changes and unwritten files and
prints the exact init command to resume. Re-running resumes only its owned,
unchanged files; edited configs or changed AO settings are never overwritten.
The recovery record is removed after init and doctor complete. This is a
recoverable transaction, not an atomic transaction spanning the AO daemon and
the filesystem: an interrupted call may require checking its outcome.

Run `tally init` again to connect a product you skipped. It proposes an
integration-only diff, preserves the rest of your config and AO ownership,
and asks for confirmation (default No). `--dry-run` shows the diff without
writing. With no proposed changes it exits cleanly. Interrupted re-init
writes can be resumed using the command printed in the error.

`tally run --dry-run` runs the same loop with simulated workers instead of
real ones.

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
| `tally experiment` | Run simulated baseline and Tally modes with `--dry-run --repeats N` (default 2). Real experiment execution is currently gated. `--budget <usd>` is the aggregate safety cap. Baseline keeps no per-task ceiling; real worker base validation and safety monitoring are implemented but have not been exercised live. |
| `tally demo` | Run the full loop with simulated workers on `demo/tally.yaml` and `demo/sample-backlog.yaml`. No accounts or keys. Writes `.tally/runs/<run-id>/run.json` and `ledger.json`; add `--dashboard` for the one-command demo, or `--live` to light up read-only integrations while workers stay fake. |
| `tally dashboard` | Serve `dashboard/` and `.tally/runs/` read-only on `127.0.0.1`. The printed URL passes `?data=/runs/latest/` so the page reads the stable latest-run mirror. |
| `tally init` | Preview files and AO changes, then ask final default-No consent. `--dry-run` previews; `--yes` applies defaults without prompts. Scoped worker allow-list enforcement is not yet installed. |
| `tally uninstall` | Confirm removal of init-owned configuration and AO settings; preserve history and credentials. |
| `tally doctor` | One line per integration: connected, missing or broken, with the fix. |
| `tally login cfoai` | Sign in to cfo.ai; tokens are cached outside the repository. |
| `tally traces drain --run <id>` | Recover only that finished run's worker traces, verify readable spans, then update saved status and worker trace ids. Use `--output <run-dir>` for a run stored elsewhere. |
| `tally market --limit 5` | Search CrustData for companies adopting coding agents; requires its credentials. |
| `tally publish --out site` | Static dashboard export with a sensitive-content scan. No deployment. |

`run --dashboard` starts serving before the first task and prints the URL
immediately. `--open` also opens that URL in the system browser. The server
continues after the run for inspection, until Ctrl+C. Terminal output includes
routes, worker session IDs, spend updates at most every ten seconds, attempt
results, PR URLs and a final summary. `--budget` is a cap for this run, not a
replacement for the monthly budget: plan and summary show both, including the
monthly source. When cfo.ai supplies the monthly budget, init asks only for a
local fallback after connecting it. Worker trace IDs require correlated trace
read-back; unverified delivery is shown as missing rather than success.

## Layout

Experiment summaries are atomically updated after each completed run at
`.tally/runs/experiments/<experimentId>/summary.json`. The dashboard server lists
them in `/runs/index.json` under `experiments`. Each underlying run retains its
own folder, `mode`, and `repeat`. Simulated cost remains labeled as simulated.
The aggregate watcher polls once a second; reported final cost can exceed the
stop threshold due to polling or metering lag and is never clipped to the cap.

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

With neatlogs on, Tally drains the completed Codex worker's hook spool from
its own process, outside the worker sandbox. It uses the official package's
spool API (there is no flush CLI), matching native session IDs or the worktree
path. Only successfully delivered batches are acknowledged; failed,
unrelated and malformed batches remain queued. A locked or incomplete drain
is reported as missing worker trace delivery. Dry runs do not drain workers.

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
(1 USD = 1,000,000,000). List-price estimates multiply aggregate tokens by the
configured rates in `tally.yaml`; they are normalized estimates, not invoices.
New ledger rows snapshot those rates in `price` and record their source and
verification status in `priceNote`. Unknown models/providers or rates that
disagree with the verified snapshot are labelled unverified. Operator-supplied
`tiers[].priceNote` is retained as a config note, not independently verified.

### Codex Tier Prices

Official base text rates checked 2026-10-11, USD per million tokens:

| Model | Input | Cached Input | Output | Source |
|---|---:|---:|---:|---|
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.6-luna) |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.6-terra) |
| gpt-5.6-sol | 4.00 | 0.40 | 20.00 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |

```yaml
tiers:
  - { name: cheap, harness: codex, sessionMode: tui, provider: openai, model: gpt-5.6-luna, price: { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 }, ceilingFraction: 0.2 }
  - { name: middle, harness: codex, sessionMode: tui, provider: openai, model: gpt-5.6-terra, price: { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 12 }, ceilingFraction: 0.5 }
  - { name: top, harness: codex, sessionMode: tui, provider: openai, model: gpt-5.6-sol, price: { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 }, ceilingFraction: 1 }
```

Per-request prompts above 272K input tokens have input/output uplifts;
cache writes also have an uplift. AO's aggregate token buckets cannot resolve
these adjustments. Sol's published promotional rates last at least through
2026-11-21; recheck before subsequent runs. Historical costs are not repriced.

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
