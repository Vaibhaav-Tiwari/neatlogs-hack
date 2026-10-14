![Meet Tally, the CFO for your agent fleet: pixel tally mark on a dark background](https://raw.githubusercontent.com/Vaibhaav-Tiwari/neatlogs-hack/main/docs/assets/tally-banner.png)

Tally is a CFO for coding agents: give it GitHub issues and a budget, and it routes, caps and verifies the work before opening pull requests.



### Tally demo
[![Watch the Tally demo](https://img.youtube.com/vi/UhWth0l9tBM/maxresdefault.jpg)](https://youtu.be/UhWth0l9tBM)

### Walkthrough of one of many PRs
[![Watch the Tally demo](https://img.youtube.com/vi/3eK1HM9C9pI/maxresdefault.jpg)](https://youtu.be/3eK1HM9C9pI)



## Install

```sh
npm install -g tally-agents
```

Published version: **0.2.1**, checked on npm on 13 October 2026.
Requires Node 20+; real work also needs Git, signed-in GitHub CLI and at least
one signed-in coding agent. Optional integrations are not required.

## 60-Second Quick Start

From your repository root, with open issues carrying your chosen label:

```sh
tally init
tally run --plan
tally run --budget 3 --dashboard
```

Init asks about runner, agents, verification, budget and integrations. Review
the plan before the last command: **it starts paid workers and may push task
branches/open PRs**. Replace `3` with your approved USD run budget. Connection
and setup can take longer than a minute; the dashboard serves until Ctrl+C.

Excerpt from a real AO run, not the simulated demo:

```text
#21 attempt 1: passed $0.0126 https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/22
#20 attempt 1: passed $0.0136 https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/23
#19 attempt 1: passed $0.0150 https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/24
finished run-20261011-190131Z: 3 tasks, 3 attempts
summary: 3 passed, 0 failed, 0 skipped; total $0.0411 against run cap $2.00
```

Try it without accounts or paid workers: `tally demo --dashboard --port 0`.
The seven demo tasks and token usage are scripted, not real savings evidence.

## What Tally Does

1. **Route:** size tasks and choose configured tiers using confidence, cost
   and past outcomes when available.
2. **Cap:** reserve budget and meter workers against their attempt ceilings.
3. **Escalate:** stop capped/failed work and, when appropriate and affordable,
   pass its branch and available checkpoint metadata to a stronger tier.
4. **Verify:** independently run your configured repository checks.
5. **Open a pull request:** publish verified work with a cost/evidence ledger.
   **Tally never merges its task PRs.**

Both the run cap and remaining monthly budget apply. Polling/metering can
overshoot a ceiling; this is not a provider-side hard billing limit.

## Runners and Agents

| Runner | Execution | Agents |
| --- | --- | --- |
| Agent Orchestrator (`ao`) | AO manages sessions; opt into parallel workers at init or with `--parallel N` | Claude Code, Codex or configured mixed tiers |
| Direct (`direct`) | Tally launches workers itself, one task at a time; no AO daemon needed | Claude Code or Codex, selected per tier |

Install/sign in to every configured harness. Tally never silently substitutes
one for a missing agent. Login does not prove model entitlement. Claude uses
a scoped consented allow-list; no runner uses bypass-permissions.
[Runner details and proofs](docs/EVIDENCE.md).

## Optional Integrations

| Product | Adds | When Off or Unavailable |
| --- | --- | --- |
| neatlogs | Decision/worker traces, read-back evidence, cost/pass-rate history and learned caps keyed by size and actual model | No Tally decision export when off; local history, then explicit priors/config caps. Previously installed global hooks may still trace sessions. |
| Entire | Graph sizing, checkpoints, past-failure recall and metadata-only handoff | Repository search sizes tasks; no Entire checkpoints/hosted recall promised. No symbol matches falls back without calling a working graph disconnected. |
| cfo.ai | Monthly budget read, reconciled real spend and workspace-shared per-attempt Ari reports when enabled | Local budget/ledger; failed writes retain `cfoai-spend-fallback.csv` for reconciliation. |

Credentials stay in their login tools or `~/.tally/`, not the repository.
A stored trace ID does not itself prove delivery.

## Evidence, Not Promises

| Matched Three-Task Pass | Estimated Cost | Final Tasks Passing |
| --- | ---: | ---: |
| Every task on the top tier | $1.22 | 3/3 |
| Tally v1, built-in priors | $0.31 | 3/3 |
| Tally v2, history enabled | $0.43 | 3/3 |

**Three tasks, one run each per pass**, same initial commit, list-price token
estimates rather than invoices: about 75% and 65% cheaper on that sample. Each
pass also had three separately recorded startup retries. Only C's large task
used observed history; no tier/cap changed. C cost more than B: this does not
prove history improved on priors or guarantee savings on another workload.

- **Cap and escalation:** [fly-doom-jev PR #17](https://github.com/Vaibhaav-Tiwari/fly-doom-jev/pull/17),
  `run-20261012-100856Z`: cheap stopped at $0.018 (metered $0.01956), middle
  passed at $0.16958; the failure classification was ledger-derived.
- **Parallel AO:** the three overlapping workers above cost $0.04111932.
  The 0.2.1 sanity run also produced
  [PR #35](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/35) and
  [PR #36](https://github.com/Vaibhaav-Tiwari/chip-design-groundup/pull/36),
  2/2 passing at $0.02483996 with reconciled spend/read-back traces.
- **Live learned ceiling:** [Othello PR #5](https://github.com/Vaibhaav-Tiwari/Othello/pull/5),
  `run-20261012-153240Z`: six successful small/luna observations from neatlogs
  set a P90 x 1.5 cap of **$0.02284986**, below the configured $0.30; passed
  at $0.01816744.
- **Learned cap caused escalation:** in self-host run `run-20261012-162757Z`,
  tasks #155/#157 stopped at a learned **$0.02725116** cap (metered $0.02817828
  and $0.02770580). Middle/terra passed on each same branch at $0.19549280
  and $0.38153360: [PR #163](https://github.com/Vaibhaav-Tiwari/neatlogs-hack/pull/163)
  and [PR #162](https://github.com/Vaibhaav-Tiwari/neatlogs-hack/pull/162).
  Both assessments are `ceiling`, source `ledger`, because worker traces were
  unreadable then; not trace-derived failure diagnoses.
- **Four paths:** individual real PRs exist for Claude and Codex through AO
  and directly. [Full evidence and reference](docs/EVIDENCE.md).

These later user runs demonstrate learned caps, not a new controlled savings
comparison. Caps require five successful samples per size/tier/model, never
exceed config, and revert to config when insufficient data exists.

## Consent and Data Sharing

Review init's proposal. Integration setup can change external systems before
the final config write. [Approval details](docs/HUMAN_APPROVALS.md).

- **Claude:** approve scoped file edits, git add/commit/status/diff and exact
  external test/setup scripts. Missing/stale consent blocks launch; no broad Bash.
- **Entire:** capture changes listed settings/local hooks. Publishing them to
  the default branch requires separate confirmation. Trust agent hooks yourself;
  hosted mirroring is another choice, generated summaries are off by default.
- **neatlogs:** key verification sends a synthetic probe; enabled tracing sends
  decisions. Optional machine-wide hooks can trace agent sessions outside Tally.
- **cfo.ai:** fresh init asks for budget, spend and Ari context, and adds a
  managed guide to the chosen page. Real attempts
  write spend and, when enabled, organization-memory reports with task/title/IDs,
  model/tokens/cost/decision/outcome, budgets and evidence URLs. They exclude
  issue bodies, source/diffs, prompts/transcripts and raw spans. Re-init currently
  uses a generic enable question: inspect its reporting disclosure/proposal.
- **PR evidence:** available Entire/neatlogs/cfo.ai links are appended to task
  PR bodies. There is **no separate init question for finance-URL sharing**.
  Links do not grant access, but PR readers can see their addresses.

Never paste keys into YAML, issues, PRs or diagnostics. Free-text labels and
result notes still need care; sanitization is not a complete privacy guarantee.
Dry runs never write simulated spend/Ari reports, but can export decision
traces when neatlogs is enabled.

## Known Limits

- Early product; verification is only as strong as your configured checks.
- Never run two Tally processes against one cfo.ai page: cross-process spend
  writes are not atomic and can overwrite one another.
- Mixed AO permission switching is locked only within one Tally process.
  Direct escalation and no-account onboarding need broader live validation.
- Direct processes cannot be reattached after exit. Codex metering uses an
  internal rollout format; missing metering stops the worker.
- Model access, trace delivery and hosted recall are separate evidence checks.
- 0.1.0 configs load sequentially unchanged; new config fields do not work on
  0.1.0. Built runtime supports Node 20; source tests need a Vitest-supported
  runtime (22.12+ on Node 22).

## For AI Agents

Read [the self-contained agent guide](docs/AGENT_GUIDE.md) before using Tally
on a person's repository: human choices, verified flags, plan/state/ledger
interpretation and failure handling. It ships with npm; [llms.txt](llms.txt)
provides discovery links.

## More

- [Getting started](docs/GETTING_STARTED.md)
- [Business plan and labelled assumptions](docs/BUSINESS_PLAN.md)
- [Detailed evidence and operational reference](docs/EVIDENCE.md)
- [Website](https://tally-agents-pi.vercel.app/)
- [npm](https://www.npmjs.com/package/tally-agents)

GitHub alternative: `npm install -g github:Vaibhaav-Tiwari/neatlogs-hack#release`.
The release branch is prebuilt; main is source-only.

## Licence

[MIT](LICENSE).
