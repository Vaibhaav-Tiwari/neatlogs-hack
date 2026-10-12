# Getting Started With Tally

Tally takes GitHub issues and a budget, then routes each task to a coding model likely to finish it economically. It watches token spend, verifies the changes with your repository's test command, and can hand failed or ceiling-stopped work to a stronger tier. You get pull requests and a ledger of each attempt, not automatically merged code.

## Choose Your First Step

- **See it without accounts:** follow [Try the demo](#try-the-demo-with-no-accounts).
- **Use your own repository:** follow [Prepare a repository](#prepare-a-repository).
- **Understand the safety limits first:** read [What is and is not proven](#what-is-and-is-not-proven).

## Requirements

For the offline demo and dashboard: **Node.js 20 or newer and npm**. No GitHub login, agent login, API key, or Agent Orchestrator is needed.

For a real run, also have:

- Git and a local clone of a GitHub repository you can push branches to.
- [GitHub CLI](https://cli.github.com/), signed in with access to that repository.
- At least one installed, signed-in coding agent: [Claude Code](https://code.claude.com/docs/en/setup) or [Codex CLI](https://developers.openai.com/codex/cli/). Your account must have access to the models you select; a successful login check does not prove model access.
- A verification command that exits successfully only when the relevant work is acceptable. Tally will not invent `npm test` for a repository without tests.
- Optionally, [Agent Orchestrator](https://docs.orchestrator.inc), installed and running, if you choose `runner: ao`. The direct runner needs no AO daemon.

neatlogs, Entire, and cfo.ai are optional. You can leave all three off and still run tasks, verify changes, publish PRs, and inspect the local ledger.

## Install

```sh
npm install -g tally-agents
tally --version
tally --help
```

The package is `tally-agents`; the command is `tally`. Version `0.1.0` was available on npm when this guide was checked.

The first bare `tally` or `tally init` in an interactive terminal plays the logo once. Piped output and other commands skip the animation. Use `tally logo` to replay it or `TALLY_NO_ANIMATION=1 tally init` to disable motion.

The alternative prebuilt GitHub install is:

```sh
npm install -g 'github:Vaibhaav-Tiwari/neatlogs-hack#release'
```

Keep the quotes, especially in zsh. Use `#release`, not the source-only main branch; the release includes compiled code and `release-source.json` identifying its source commit.

## Try the Demo With No Accounts

In an empty working directory:

```sh
mkdir tally-demo
cd tally-demo
tally demo
tally dashboard
```

Open the URL printed by the second command. The demo runs seven sample tasks through the same sizing, routing, watcher, escalation, verification, and ledger loop as a real run, but the workers and their usage/test outcomes are scripted. Its costs are marked simulated, not actual agent charges.

For a single command that also opens your browser:

```sh
tally demo --dashboard --open --port 0
```

`--port 0` selects a free local port. The dashboard keeps serving until Ctrl+C; that is expected, not a hung demo. `tally dashboard` can reopen saved results later from the same directory.

Do not use `tally demo --live` as your no-account test: it reads enabled integrations using your credentials, though workers stay simulated and it does not write cfo.ai spend.

## Prepare a Repository

Use a clean checkout of the repository's intended default/base branch. Init records the current checkout branch as its base proposal, so review that value before applying it.

```sh
git status --short
gh auth status
```

Sign in to the agent you intend to use, not both unless you want both:

```sh
claude auth login
claude auth status
```

Or:

```sh
codex login
codex login status
```

Then, in the target repository root:

```sh
tally doctor
tally init
```

Before init, doctor checks core account availability and shows AO plus optional sponsor integrations as off because no runner or products have been selected yet. Run it again after init to check the actual repository, runner, harnesses and integrations in your configuration.

### Every Init Question

Some questions are conditional: detected commands, existing credentials, already-enabled capture, or explicit CLI flags can remove a prompt. Pressing Enter accepts the displayed default. Every `y/N` defaults to **No**.

| Question or step | What to answer and why |
| --- | --- |
| Test command, when none is detected | Enter the exact shell command that verifies this repository. Init detects Makefile `test`, package.json `scripts.test`, pytest configuration, Cargo, or Go evidence. If nothing is found, blank input stops init; there is no guessed test command. Review a detected command in the final summary too. |
| Optional setup command, when none is detected | Enter the reproducible environment-setup command, or leave blank if none is needed. Detection includes Makefile/package setup scripts, lockfile-based dependency installs, and `uv sync`. Setup runs before the coding agent starts, not inside its task ceiling. |
| GitHub issue label for Tally tasks | Use `tally`, or a dedicated label you will actually apply to issues. The label controls which open issues enter the backlog. |
| Enable Neatlogs traces? | Say yes to send Tally routing and task traces to Neatlogs. Past-run history is a separate read-only opt-in. |
| Enable Entire graph and checkpoints? | Say yes for code-impact sizing and local session/checkpoint handoff. Hosted past-failure recall is optional and requires the repository to be accessible to Entire. |
| Use cfo.ai for the monthly budget and spend? | Say yes to read the monthly budget and write real agent spend to your cfo.ai model. No uses the local configured budget and ledger. |
| Runner: AO or direct? | Choose `direct` for Tally-managed local agent processes/worktrees without AO, or `ao` for AO-managed sessions. Init defaults to AO only when its daemon reports running; if AO is missing, stopped or cannot be verified, init defaults to direct and explains why. Direct always runs one task at a time. |
| Run tasks in parallel through AO? | AO only; default No keeps one worker. Say yes, then enter the maximum worker count. Each task reserves its first ceiling plus one possible escalation against both budgets, so available funds can reduce actual overlap. Parallel execution is covered by fake-loop tests; its live proof is pending. |
| Coding agents: Claude Code, Codex, or mixed? | Type `claude-code`, `codex`, or `mixed`. Only installed, signed-in agents are usable. Mixed currently proposes cheap Codex and stronger Claude tiers; inspect the exact models in the summary. Tally never silently substitutes a different harness. |
| Optional model-access fallback tier | Enter a configured tier name, or leave blank to keep fail-fast behavior. Tally uses it once only after the active account explicitly rejects a model; the fallback gets its own normal spend ceiling and must fit the remaining budget. This does not catch auth, network, quota, or rate-limit failures. Scripted init can set `--model-access-fallback-tier <name>`. |
| Approve the Claude Code allow-list? | Asked only if any tier uses Claude. Review every rule and the printed test/setup script contents, then say yes only if you trust them. No stops setup of those Claude tiers; choose Codex instead or rerun when ready. |
| Monthly budget or local fallback | Without cfo.ai, enter your monthly local budget, which is also the default run cap. With cfo.ai connected, init shows its current monthly figure and asks for a local fallback if reads fail. That fallback does not change the live cfo.ai budget. Always choose a separate small cap for your first run. |
| Apply these changes? | Read the repository/base branch, runner, tiers, prices, tests, setup, products, files and AO changes. Say yes to write `tally.yaml` and `.tally/install.json` and apply the listed AO changes. No leaves those final installation changes unapplied. Previously approved integration connection changes are separate, not rolled back by this answer. |

With `ao`, init registers or updates this repository's project, preserves existing fields, and adds the owned setup/post-create configuration. With `direct`, it does not register an AO project or change AO settings. Init finishes with doctor output.

For a static JavaScript site, the following is a command **actually used** in our chip-design-groundup proofs:

```sh
find js -name '*.js' -print0 | xargs -0 -n1 node --check
```

It checks JavaScript syntax, not browser behavior or Markdown correctness. Do not copy it into an unrelated repository or assume it checks everything a documentation issue asks for.

### Claude Consent and Scripts

The printed allow-list permits worktree file edits, git add/commit/status/diff, and the exact test/setup scripts. Config stores portable, content-bound script tokens, not machine-specific paths. At each worker start, Tally writes the scripts outside the worker's worktree, materialises exact permissions and tells the worker the exact verification-script path. The worker cannot edit those scripts; Tally independently runs the real test command afterwards.

There is no broad Bash permission, push permission or bypass-permissions flag. Direct workers can leave edits uncommitted: Tally commits them before verifying. Claude's allow-list is a harness policy, not an operating-system isolation guarantee; approved commands can execute repository code and setup may install dependencies. Trust the repository, scripts and installed hooks before approving.

Changing test/setup commands invalidates old consent. Rerun `tally init` to review the new contents rather than editing allow rules to unblock a refusal.

### Additional Integration Prompts

**cfo.ai:** Tally uses built-in MCP OAuth, so no separate cfo.ai CLI/package install is needed. If not connected, init offers browser login. Select your workspace and scenario from the numbered choices, or press Enter to skip. It checks the budget and spend tables. Before creating any missing table, init shows the workspace, scenario, rows, starting values, and formula in a readable proposal and asks for approval. It does not reset existing model data. An incomplete connection falls back to local budgeting. `tally login cfoai` can reconnect later. After table setup, you may separately opt in to organization-scoped Ari task reports. These give Ari the per-attempt model, token/cost assumptions, result, budget snapshot, and PR/checkpoint/trace links needed for spend questions and model what-ifs. They are shared with the selected workspace and exclude issue bodies, prompts, source, transcripts, raw trace contents, and credentials. Dry runs never publish these reports.

To verify Ari's context in a demo, ask for a task's spend and route by issue number, compare the same recorded tokens at another configured tier's rates, and ask for the monthly budget remaining at the report's snapshot time. A grounded answer should cite the attempt/run, show the rate and token assumptions, distinguish estimates from provider invoices, and say when data is missing. A same-token what-if is a price comparison; it does not establish that another model would have produced the same result.

**Neatlogs:** Tally includes the Neatlogs SDK; no separate CLI/package install is needed. Init explains each permission separately:

- The project API key sends Tally routing and task traces. Its connection check sends one synthetic span with no repository content. New keys are entered secretly and saved outside the repository.
- Past-run history is optional and read-only. It needs a service token with `context:read` and `observability:read`, plus a project selection. Tally saves the token and project ID outside the repository. If this step is skipped or cannot be verified, Tally uses local history.
- Worker hooks are optional and machine-wide. They change `~/.claude/settings.json` and `~/.codex/hooks.json` and can trace sessions outside Tally. Codex requires you to review and trust them through `/hooks`.

You can send decision traces without enabling history reads or installing worker hooks.

Plans share one bounded Neatlogs history snapshot across tier lookups. The full read has a 15-second deadline; if it stalls or fails, Tally reports the fallback and uses local history so `tally run --plan` can finish. The Public API accepts trace-list page sizes up to 50 and opaque cursors; see the [Neatlogs pagination documentation](https://docs.neatlogs.com/api-reference/pagination).

Worker tracing additionally needs harness hooks and usable read access for Tally to verify delivery. The optional **GLOBAL worker-hook installation** changes `~/.claude/settings.json` and `~/.codex/hooks.json` and traces sessions outside Tally too; approve only if you want that machine-wide behavior. Codex also needs you to trust hooks via `/hooks`. You can decline global installation and use existing hooks. Do not mistake a configured API key or decision trace for proof that worker traces arrived.

**Entire:** if its CLI is missing, init offers the official OS installer after a separate confirmation. It then offers login, Graph plugin installation, repository capture settings, missing harness hooks, and an optional browser mirror, each with its own consent. It lists generated files before asking to enable capture, then separately asks before committing those settings and pushing them to the repository's default branch. The mirror prompt is separate: approving it sends the GitHub repository copy to the Entire region or regions you choose in the Entire CLI. Decline to keep the existing setup without a mirror. Capture settings must reach the base branch for future workers; uncommitted settings are not enough. Codex hook trust is a separate `/hooks` confirmation.

Entire being off does not prevent Tally sizing tasks from issue text and repository evidence. Being on adds Graph and local checkpoints. **Hosted past-failure checkpoint recall and clickable Entire session links need an accessible repository mirrored to Entire.** Init can offer this as a separate opt-in and verifies that the mirror is ready. If you skip it, local capture and normal runs remain available, but the PR shows a checkpoint ID instead of a hosted session link. Brain is a separate memory extension; Tally does not install or use it. Generated summaries are off by default and require separate approval.

### Reading Entire's Doctor Status

Run `tally doctor` again after init. When Entire is on, it reports separate checks:

| Doctor line | What it establishes |
| --- | --- |
| `Entire CLI: connected` | The CLI is available. |
| `Entire graph plugin: connected` | The Graph command is installed; this is not proof that hosted recall works. |
| `Entire repository: connected` | Session capture is enabled in this repository. |
| `Entire Web mirror: connected` | This GitHub repository has a ready Entire Web mirror. This is separate from local capture and Git-remote checkpoint sync. |
| `Entire Web mirror: unavailable` | The mirror is optional or could not be checked. Tally keeps local capture and normal task runs available; the line includes an opt-in setup hint. |
| `Entire checkpoint recall: connected` | Hosted checkpoint search answered successfully, even if it returned no matching checkpoints. |
| `Entire checkpoint recall: unavailable` | Hosted recall could not access this repository. This is optional. The line gives a mirror/account-access hint, while local capture and normal task runs remain available. |
| `Entire checkpoint recall: broken` | Hosted search failed for another reason. The line includes the actual error and a relevant check. |

For example, a repository that is not mirrored can have the first three checks connected while hosted checkpoint recall is unavailable. This optional condition does not make `tally doctor` fail and does not mean repository capture or Graph sizing is unavailable.

The run's Entire integration detail likewise separates `Graph sizing: ok` from `checkpoint recall unavailable: ...`. Its combined status can be `missing` even while sizing works. Routing decisions include the recall-unavailable reason rather than implying past failures were consulted. Generated/tool-owned and gitignored paths are excluded from sizing; related search hits remain context, not automatic files-to-edit targets.

### Preview, Flags and Re-Init

Inspect a proposal without applying installation changes:

```sh
tally init --dry-run --verbose
```

If no tests can be detected, supply your real command even for the preview. To preselect runner/harness while keeping the remaining prompts:

```sh
tally init --runner direct --harness codex
```

`tally run --plan` prints a message when no tasks match the backlog, including when a file backlog is empty or no GitHub issues are runnable. In that case no task would start.

Available input flags include `--test-command`, `--setup-command` (an empty string means none), `--issue-label`, `--neatlogs yes|no`, `--entire yes|no`, and `--cfoai yes|no`. `--yes` approves the final detected proposal without prompting; it does not replace missing verification evidence or Claude consent. Scripted Claude setup also needs the explicit `--allow-claude` approval. Use interactive setup first if you are unsure.

Run `tally init` again to connect a product you skipped. It shows a consented diff, preserves other settings and ownership, and exits cleanly if nothing changes. If an operation fails partway through, follow the printed recovery command; preserve the ownership/pending records instead of deleting them to force a retry.

## Label a Small, Checkable Issue

First create a dedicated label if it does not exist:

```sh
gh label create tally --description "Work for Tally"
```

Create an issue in GitHub, or use the CLI:

```sh
gh issue create --label tally
```

For an existing issue, replace `ISSUE_NUMBER` below with its number:

```sh
gh issue edit ISSUE_NUMBER --add-label tally
gh issue list --label tally --state open
```

Write an issue with a precise outcome, named target files/functions, constraints and a pass check covered by your verification command. For your first task, choose a small independent change; avoid vague requests to redesign the project. Specify files that must not change too.

Open issues already linked as closing references by an open PR are excluded, so Tally does not redo work awaiting review. A casual PR mention is not necessarily a closing link; check `closingIssuesReferences` when diagnosing intake.

## Preview the Plan

```sh
tally run --plan --budget 1
```

This sizes and routes tasks without starting workers, publishing, or charging a coding model. Enabled read-only integrations may still be queried and local Graph indexes may be built. Check the task list, selected harness/model, confidence, ceiling and budget source before running.

Actual output from the direct Codex proof on chip-design-groundup, run `run-20261011-130259Z`:

```text
Budget availability
  Monthly remaining: $40.00 of $40.00 (cfo.ai)
  Run cap: $1.00 (CLI --budget)
  Available now: $1.00
#17: small (confidence 0.74) -> cheap codex/gpt-5.6-luna ceiling $0.30
```

These are recorded figures, not your defaults or a cost forecast. The monthly budget came from that cfo.ai account; `--budget 1` set only this run's cap. `small` is the estimated scope; confidence is sizing certainty, not a measured probability of correctness. `cheap` is a tier name from that config, and the ceiling is the maximum intended spend for that attempt, not a promised bill.

The following decision line explains the evidence, prior/history, expected cost and why a route fits. At the start, Tally uses conservative priors rather than pretending to have observed model performance. Ambiguous scope or insufficient confidence can send a task to a stronger tier. A skipped task means its attempt cannot fit the available budget; do not raise the cap without checking why.

To isolate one issue, quote its task ID, for example `--only '#17'`. Use your own issue number, not an issue from these proof runs. Recheck the plan with the same cap and selection you intend to run.

## Run With a Live Dashboard

For a first real run with a one-dollar cap:

```sh
tally run --budget 1 --dashboard --open --port 0
```

Replace `1` with the run cap you deliberately choose; in general the command is `tally run --budget N --dashboard`, where `N` is a positive USD amount. Real runs use your agent accounts and can push task branches and create PRs. **They never merge PRs.**

For `runner: ao`, `--parallel 3` overrides the explicit `parallelWorkers` opt-in for that run. Missing `parallelWorkers` means one worker; the legacy `concurrency` field never enables parallelism, and direct always remains sequential. Init records `parallelWorkers` only from the chosen worker mode. Before starting each parallel task, Tally reserves its ceiling and one next-tier escalation against the run cap and monthly remainder. Tasks wait for other reservations to settle, or are skipped if they cannot fit at all. Paid parallel runs require a readable monthly budget; demo/dry runs can fall back to the configured budget because workers are simulated. Baseline runs stay sequential because they have no per-task ceilings. Usage polling is asynchronous: reservations prevent overcommitting funds, but final usage can overshoot a ceiling between polls. The shared observed-budget guard stops all workers if their combined reported spend reaches the available cap.

The local dashboard address is printed before the first worker starts. `--open` opens the browser; `--dashboard` alone serves it without automatically opening it. Routes, worker IDs, periodic spend, attempt results and PR URLs appear in the terminal. The dashboard shows task state and increasing live spend; finished ledger rows appear after attempts end, not as partial rows for a running attempt.

Recorded progress excerpt from the same proof:

```text
dashboard http://127.0.0.1:5197/?data=%2Fruns%2Flatest%2F
#17 attempt 1: worker 01a12b0f-5178-7d51-be0c-92b2acb784a4 started on cheap
#17 attempt 1: spend $0.0029
#17 attempt 1: spend $0.0061
#17 attempt 1: spend $0.0109
Budget availability
  Monthly remaining: $40.00 of $40.00 (cfo.ai)
  Run cap: $1.00 (CLI --budget)
  Available now: $1.00
Run summary
  Tasks: 1 passed, 0 failed, 0 skipped
  Total spend: $0.0109
  Run cap: $1.00
PR https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/18
```

Intervening lines are omitted. That run's exact ledger cost was `$0.01085588`, not the rounded terminal total. Its [PR #18](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/18) closed issue #17 through its PR body; it was not merged by Tally.

At the end, the terminal prints pass/fail/skip counts, total/cap, monthly source, PRs, run folder and dashboard URL. The server stays up until Ctrl+C. You can later run `tally dashboard` in the same repository to reopen saved runs.

## What Happens on Failure or a Ceiling

Tally does not accept the worker's claim that tests pass. It requires changed work/commits and runs its own configured verification on the worker branch before publishing. A direct worker's nonignored uncommitted edits are committed by Tally; a clean worktree with no commits is not a pass.

If tests fail, or live metering crosses the attempt ceiling, Tally may escalate **once**, one tier up, only if that next ceiling fits the remaining budget. It stops a ceiling-crossing worker, records its actual cost, commits work in progress and continues the same branch with available handoff metadata. If there were no edits yet, the next attempt starts clean and the record says so. The stronger attempt is verified again.

Permission/infrastructure errors are not cured by blindly spending on a stronger model. A sustained request for human input, missing checkout, or unavailable live meter is reported and the worker is closed. A recovered Claude command refusal can be a warning rather than a task failure: Tally's own verification is the judge. Finished workers are closed on success and failure paths.

Ceilings are **polling-based safety thresholds, not billing guarantees**: usage arrives at model-call/message boundaries and stopping can lag. Actual spend may exceed a threshold by in-flight usage, and Tally records it rather than clipping the ledger. Setup time is recorded separately; test/setup commands and external infrastructure may have costs outside model-token accounting. Keep margin below your account-level spending limit.

## Find the Evidence

| Evidence | Where to look |
| --- | --- |
| Config and chosen tiers | `tally.yaml`; no secrets belong in this file. |
| Task state, live total and budget provenance | `.tally/runs/<run-id>/run.json`; includes real/dry-run mode, backlog source/label and monthly/run-cap sources. |
| Attempt-level costs and verdicts | `.tally/runs/<run-id>/ledger.json`; rows include tokens, configured price snapshot/provenance, ceiling, result/reason, branch, commit and PR URL. A model-access fallback is a second row; a pre-start rejection records zero cost. Money uses integer nanos: 1 USD = 1,000,000,000 nanos. |
| Latest run | `.tally/runs/latest/run.json` and `ledger.json`; the dashboard's stable data path. |
| Dashboard | Printed local URL, run picker, task decisions, attempt results and evidence links. It serves recorded files read-only on `127.0.0.1`. |
| neatlogs | Decision `traceId`/link and `workerTraceId`/link on the ledger row. Worker delivery requires capture hooks plus correlated read-back. `workerTraceDetail` and run integration status now retain actionable lock, auth, project, network, and indexing diagnostics. Null means not established, not an invisible success. |
| Entire | `checkpointId`, `entireSessionId`, a session URL when the repo has a ready Entire mirror, and handoff metadata. Off integrations or attempts without a captured checkpoint can legitimately have null IDs. The PR body and dashboard link to Entire only when the mirror is ready. |
| cfo.ai | Configured monthly `Agent budget`, `Agent spend`, `Budget remaining`, and tier rows in the spend-detail table. Dashboard/run state retain available page/table links. Real spend is written after attempts; a failed write is exposed with `cfoai-spend-fallback.csv`, not silently treated as success. |

Costs are list-price token estimates, not provider invoices or subscription cash charges. Changing prices does not reprice past ledgers. With cfo.ai off, no model cells are read or written; with neatlogs off, no decision traces are exported; with Entire off, no checkpoint evidence is promised.

## The Four Runner Paths

All four have completed individual real tasks on chip-design-groundup:

| Runner / harness | How workers run | Recorded PR evidence |
| --- | --- | --- |
| AO / Codex | AO owns a Codex tui session and exposes usage; Tally verifies/publishes. | [#10](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/10) |
| AO / Claude Code | AO starts Claude with worktree-local consented settings/scripts; Tally verifies/publishes. | [#13](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/13), [#16](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/16) |
| Direct / Claude Code | Tally starts `claude -p`, meters streamed usage including cache writes, host-commits edits and publishes. | [#14](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/14) |
| Direct / Codex | Tally starts `codex exec --json`, reads live usage only from its own session's rollout, host-commits edits and publishes. | [#18](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/18) |

Direct Codex uses a workspace-write sandbox with network disabled and no bypass/full-access mode. Direct Claude uses consented `dontAsk` tool rules, not that same OS sandbox. Both receive Tally's exact verification script; Tally handles publishing. Usage and trace evidence are separate: a worker can be metered without having delivered its neatlogs trace.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Agent missing or signed out | Install the selected CLI and run `claude auth login` or `codex login`, then doctor. Tally stops rather than substituting another harness. Login alone does not establish entitlement to a particular model. |
| No test command found | Supply your repository's real verification command with interactive init or `--test-command '...'`. `--yes` without a detected/supplied command fails. Do not guess `npm test` for a static repository. |
| Claude consent missing/outdated, or raw-command rules rejected | Rerun `tally init`, review the current script contents and approve the allow-list. Do not add broad Bash permissions or bypass flags. The old literal pipeline rules did not reliably authorize complex commands. |
| Worker tries a raw test pipeline or refuses an off-list command | Current prompts ask it to run the exact external script. Check `permissionWarnings` and the verdict; a recovered refusal is not automatically fatal. Do not loosen permissions blindly. |
| `ao` not on PATH in a normal terminal | Use direct, or set `TALLY_AO_BIN` to the installed AO executable. On macOS Tally also looks inside the Agent Orchestrator app bundle; doctor and init use the same resolver. |
| AO session stalls on setup/permissions | Check doctor and init's owned setup/permission configuration. Setup must happen before the worker. Chat-mode prompt behavior is not proof of unattended execution; use the configured/proven tui path and never bypass safety. |
| GitHub timeout/reset/5xx | Read-only intake and PR discovery retry network-class failures up to three attempts with a printed retry line. Auth/not-found errors and publishing writes are not blindly retried. Follow the surfaced `gh` diagnostic command; check auth/network before retrying a run that might already have published. |
| Plan has no tasks | Check `gh issue list --label tally --state open`, using your chosen label. Already-closing open PRs are excluded. A zero-task run prints the repository, label and issue-labeling command and starts no worker. |
| Larger-than-expected route or budget skip | Inspect named target files, confidence, test coverage, selected tiers and ceilings. `--budget` is a run cap; the monthly cfo.ai budget is separate. The next escalation ceiling must fit too. |
| `Entire checkpoint recall: unavailable` while Graph/capture are connected | Hosted history cannot see this repository. This does not block local checkpoints, Graph sizing, or normal runs. Mirror the repository only if you want hosted past-failure recall. |
| Entire verification mentions a baseline command failure | The baseline test runs on the base checkout before the candidate check. Inspect that base run separately; Tally records its nonzero exit in the attempt reason, then applies the candidate verdict against the recorded baseline. |
| Worker trace missing | Read `workerTraceDetail` in that attempt's ledger row and the Neatlogs integration detail in `run.json`. They distinguish pending spool batches/lock contention, missing credentials, API status codes, missing correlation, and spans still indexing. Tally retries a lock-contended drain once after all workers exit; if read-back still fails, check hook trust, project binding and read scopes, then use the exact `tally traces drain --run RUN_ID` command shown in the run details for finished-run recovery. |
| A configured model is rejected by the signed-in account | By default Tally stops and names the rejected tier. To opt into one budget-checked retry, choose a different configured tier in init or add `modelAccessFallbackTier: <tier-name>` to `tally.yaml`. This handles explicit model-access rejection only; fix authentication, network, quota and rate-limit errors at their source. |
| cfo.ai unreachable or write failed | Check `tally login cfoai` and doctor; review the displayed fallback/source. Keep the CSV fallback and reconcile before changing cells manually or rerunning work. |
| Dashboard still running after completion | Expected: inspect the saved run, then Ctrl+C. Use `--port 0` if the default port is occupied. |
| Init fails after an approved operation | Read its explicit changed/unwritten list and recovery command. Re-init preserves owned matching files; it refuses to overwrite unrelated edits. Optional integration side effects have their own approvals. |

Never paste credentials into issue bodies, configs or diagnostic reports. Tally loads secrets from `~/.tally/.env`; provider logins remain owned by their CLIs.

## What Is and Is Not Proven

- Tally never merges task PRs; review them yourself. Its optional Entire setup flow may publish capture settings to the default branch only under a separate, explicit approval.
- Verification is only as strong as your configured test command. Syntax validation passing does not prove runtime behavior, accessibility or documentation accuracy.
- All four individual runner paths above are proven, but **mixed AO with an actual Codex spawn after Claude, parallel workers, and direct-runner escalation are not yet proven live**. Tests and simulated runs are not that proof.
- AO same-branch stop/escalation has real evidence; direct implementations have fake-port coverage but not equivalent live escalation proof.
- Direct live metering depends on harness event timing; Codex's rollout JSONL is an internal format that may change. Missing metering stops the worker. A direct process cannot be reattached after Tally exits.
- Past-failure recall needs hosted repository mirroring/access. Entire capture and Graph availability do not establish it, and Brain is not part of the current Tally integration.
- Paid AO experiments require explicit `--yes --budget <usd>` consent and a test timeout; they verify without pushing or opening PRs. Real comparison safety monitoring is not yet proven. Do not treat `tally demo` or an experiment dry run as evidence of real savings for your repository.

## Uninstall

In each repository you initialised:

```sh
tally uninstall
```

It lists owned config/installation files and AO registration/hooks/settings, then asks default-No confirmation. It refuses to overwrite user changes or remove a project with active sessions. If you edited the config after init, preserve it and follow the refusal message rather than deleting ownership records.

Run history, credentials, optional integration data and globally installed hooks are not removed by this repository uninstall. Review separately consented global hooks through their own tools; do not assume uninstall reverted them.

To remove the CLI itself:

```sh
npm uninstall -g tally-agents
```

Your existing PRs are not closed or merged, and your saved run evidence remains yours.
