# Tally Agent Guide

Instructions for an AI coding agent asked to "use Tally on this repo".
Self-contained for tally-agents 0.2.1. Work from the target repository root.
That request alone is not permission to spend, publish or change external data.

## Hard Rules

- Never merge Tally's PRs; the human reviews/merges.
- Never push to a default branch. If Entire setup offers a settings commit
  and default-branch push, stop and hand that step to the human. Do not approve
  it on their behalf. Normal task publication targets worker branches.
- Never use bypass-permissions, danger/full-access flags or loosen a sandbox.
- Never edit tally.yaml/install records to skip a consent. Have the human
  rerun init and approve the exact current rules instead.
- Never run two Tally runs against one cfo.ai page at once; coordinate with
  other operators. Cross-process spend updates are not atomic.
- Never paste/read out keys or tokens, reuse another tool's tokens, or put
  secrets in YAML/PRs/issues. Tally stores its secrets outside the repository.
- Never guess tests, model access, prices or savings. Do not create issues,
  install global hooks or start paid work without the applicable approval.

## Preconditions: Read-Only Checks

Run these; summarize status without exposing account details or credentials:

```sh
pwd
git status --short
git rev-parse --show-toplevel
node --version
npm --version
git --version
gh --version
gh auth status
tally --version
tally init --help
tally run --help
```

Node must be 20+. Published version checked 13 October 2026: 0.2.1. Installed
and source versions can differ. If absent, ask before installing with
`npm install -g tally-agents`. The installed CLI is `tally`, not `tally-agents`.

Check the human's chosen coding CLIs without making inference calls:

```sh
claude --version
claude auth status
codex --version
codex login status
```

Claude must report loggedIn true; Codex must report logged in. Missing/sign-out
blocks that harness; no silent substitution. Hand login to the human. Sign-in
does not prove model entitlement; ask about access to each configured model.

If AO is installed and requested:

```sh
ao version
ao status --json
```

Require ready/healthy; direct needs no AO. Tally also resolves AO through
TALLY_AO_BIN, repo.aoBin and macOS app bundles, so absent PATH alone is not
proof it is missing. Do not modify project settings to make a check pass.

For enabled Entire, read state first:

```sh
entire --version
entire auth status --json
entire plugin list
entire status --json
```

## Named Human Decisions

Put each decision to the human and retain the answer:

| Decision | Human Choice |
| --- | --- |
| Budget and caps | Monthly/local fallback budget, USD run cap and per-size/tier ceilings; escalation reserves; possible metering overshoot |
| Runner | AO with approved parallel count, or sequential direct |
| Agents and tiers | Claude, Codex or mixed; model IDs, rates, entitlement and any access-denial fallback |
| Tasks/verification | Exact issue label/task set, meaningful test and optional setup commands; setup executes repo code |
| neatlogs integration | Decision export, history read/project access and optional global hooks affecting sessions outside Tally |
| Entire integration | Login/plugin/capture/hook trust/mirror and human-owned default-branch settings publication |
| cfo.ai integration | Workspace/scenario, monthly budget/spend write-back, and separate missing-table creation approval |
| Claude allow-list | Scoped file writes, git add/commit/status/diff and content-bound test/setup script rules |
| Entire default-branch commit | Human reviews files and performs this separately; agent must stop before approving any push |
| cfo.ai reports | Managed guide and organization-memory attempt reports; includes task titles/IDs, model/tokens/pricing/cost/result/decision, budgets and links |
| PR evidence links | Entire/neatlogs/cfo.ai URLs become visible to PR readers; no dedicated init finance-sharing question, so ask yourself |
| Paid run/publication | Explicit approval for this task set, cap, worker branch pushes and PR creation, never merges |

Fresh cfo.ai init names Ari context; re-init asks a generic integration question
and can add reports to an existing installation. Explain before re-init.
Reports exclude issue bodies/source/diffs/prompts/transcripts/raw spans, but
titles/result notes are shared metadata; sanitization is not a privacy guarantee.
Declined integrations must stay off; do not force them on in YAML.

## Init: Preview Before Applying

Prefer interactive `tally init` for human-owned account/consent steps. Piped
input is rejected. Do not automate browser approval or secret entry.

Explicit non-interactive preview, integrations off:

```sh
tally init --dry-run --yes --runner direct --harness codex \
  --budget 5 --issue-label tally --test-command 'npm test' \
  --setup-command '' --neatlogs no --entire no --cfoai no --verbose
```

Replace budget/label/test/setup with approved values. Do not assume npm test
exists. Empty setup means none. After explicit approval the apply form removes
`--dry-run`; `--yes` is not blanket consent to external integration actions.

Verified init flags:

- `--config PATH`: config location (default tally.yaml).
- `--runner ao|direct`, `--harness claude-code|codex|mixed`: chosen execution.
- `--parallel N`: approved AO concurrency; direct stays sequential.
- `--budget USD`, `--issue-label LABEL`, `--test-command CMD`, `--setup-command CMD`.
- `--allow-claude`: approves the printed repository allow-list; only after the
  human reviewed those exact test/setup script contents.
- `--model-access-fallback-tier NAME`: one budget-checked explicit model-access
  denial fallback, not permission to choose another model arbitrarily.
- `--neatlogs yes|no`, `--entire yes|no`, `--cfoai yes|no`: explicit opt-ins.
- `--verbose`: full proposed YAML; `--dry-run`: preview only.

Yes integration flags do not guarantee unattended onboarding: OAuth, project/
workspace choice, table creation and hook trust can still need the human.
Selecting cfo.ai includes reporting when supported; neatlogs hooks can be global.
If any required decision is missing, stop rather than infer it.

After init, using the chosen label/budget:

```sh
tally doctor --config tally.yaml
gh issue list --label tally --state open
tally run --plan --config tally.yaml --budget 5
```

Do not create/label issues without approval. Doctor checks connection, not
paid model entitlement or delivery of every checkpoint/trace feature.

## Read the Plan Before Spending

Plan starts no worker and writes no spend/PR; it may read GitHub, repository/
Entire signals, history and cfo.ai budget. It is not offline.
Tell the human task count/IDs, model/harness/tier, size/confidence, per-attempt
ceilings, reason and history source. Distinguish observed samples versus priors,
and configured versus P90-derived caps (five successful size/tier/model samples).
Report run-cap/monthly-remaining minimum and escalation reservations, not just
the first-attempt spend. Off/missing integrations and local fallbacks matter.
Ask again if effective task set, budget or permissions changed since approval.

Optional simulation with the reviewed configuration:

```sh
tally run --dry-run --plan --config tally.yaml --budget 5
tally run --dry-run --config tally.yaml --budget 5
```

Fake workers do not prove model access or work quality. Dry runs can export
decision traces with neatlogs on, but never write simulated spend/Ari reports.
`tally demo` uses bundled integrations-off data for a no-account simulation.

## Start Only the Approved Run

After explicit approval for spending and task-branch/PR publication:

```sh
tally run --config tally.yaml --budget 5 --dashboard --port 0
```

Run flags verified in current help: `--only TASK_ID` (use plan's exact ID),
`--parallel N` (AO only), `--open` (browser), `--config PATH`, `--budget USD`,
`--dashboard`, `--port N`, `--plan`, `--dry-run` and `--baseline`.
Baseline removes task ceilings and sends work to the strongest tier: never use
without separate approval. Ordinary run needs no `--yes`; executing it is the
paid/publication action. Do not add paid experiment/retry runs opportunistically.

Record the printed run ID/output path/dashboard URL immediately. Serving
continues after completion until Ctrl+C. Direct workers cannot be reattached
after Tally exits. Inspect existing PRs and saved state before restarting;
restarting can spend again.

## Read run.json and ledger.json

Default output: `.tally/runs/RUN_ID/run.json` and `ledger.json`, relative to
the current working directory; trust printed paths. `latest/` mirrors the
latest run. Ledger is an array of attempt rows; run.json contains task/budget/
integration state. Parse JSON, do not infer success from a terminal exit alone:

```sh
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(".tally/runs/latest/run.json","utf8"));const l=JSON.parse(fs.readFileSync(".tally/runs/latest/ledger.json","utf8"));console.log(JSON.stringify({runId:r.runId,status:r.status,dryRun:r.dryRun,budget:r.budget,integrations:r.integrations,tasks:r.tasks.map(t=>({id:t.taskId,status:t.status,reason:t.statusReason,usd:t.spentNanos/1e9,pr:t.prUrl})),attempts:l.map(a=>({id:a.attemptId,tier:a.tier,model:a.model,usd:a.estimatedCostNanos/1e9,result:a.result,reason:a.resultReason,failureAssessment:a.failureAssessment,pr:a.prUrl}))},null,2));'
```

USD fields are integer nanos: divide by 1e9. Run status running/finished/
interrupted differs from task pending/running/passed/failed/skipped;
**finished does not mean all tasks passed**. Live task costs can precede ended
ledger rows. Sum all attempts including stops/errors/escalations, not only
passing ones. price/priceNote/costSource explain estimates, not invoices.

failureAssessment, when present, records kind/source/evidence/retryable.
Ledger fallback is not trace-derived. traceId is CFO decision; workerTraceId is
the separate worker. Null/unverified IDs are not evidence of delivery.
checkpointId/entireSessionId differ from AO sessionId. Review scopeWarnings,
permissionWarnings and integration detail; do not disclose raw transcripts or
financial snapshots without approval.

## Failures: Correct Responses

| Symptom | Response |
| --- | --- |
| Reservation/next ceiling does not fit | Report task and available budget; ask about priority/new cap, never increase it yourself |
| AO project not found/not ready | Inspect doctor/displayed AO diagnostic; human repairs/re-inits or chooses direct; never silently substitute |
| Signed-out/missing harness | Report the selected CLI, hand login to human, rerun doctor/plan |
| Model unavailable | Only the configured budget-checked access fallback may retry; do not choose a guessed model |
| Missing/stale Claude consent | Human reruns init and reviews exact rules; never patch/bypass permissions |
| Ceiling stop | Read spend/branch/checkpoint and classification source; Tally may perform the approved affordable escalation, not your same-tier retry |
| Verify failed | Report command/verdict; preserve branch, never weaken tests or merge; escalation stays inside the approved budget |
| Tool/permission/environment error | Stronger models may hit the same wall; ask for repair, not speculative paid retries |
| neatlogs error/pending worker trace | Preserve queued batches/ledger; report local fallback versus unverified delivery, not all-features success |
| Entire no symbols/hosted recall unavailable | Code-search sizing can be valid; capture and hosted recall are different; no mirror without consent |
| cfo.ai read/write/report error | Report budget source/sanitized detail/CSV fallback; reconcile before rerunning and avoid concurrent writers |
| PR push/evidence failure | Inspect existing branches/PRs first; publishing retries push once automatically; no force/default-branch push |

Finished-run trace recovery is `tally traces drain --run RUN_ID`: network
export/read-back, not inference. Ask before export; restrict it to this run,
never delete unrelated queued batches.

## Report Back

Give run ID/state, passed/failed/skipped counts, each PR link, cost including
failures/retries versus cap, verification outcomes, failure classification and
source/evidence, off/broken integrations and fallback, unverified evidence,
and spend/report write-back status. Distinguish simulations from real work and
estimates from invoices. Name what is unproven; leave PRs open and state that
you merged nothing.
