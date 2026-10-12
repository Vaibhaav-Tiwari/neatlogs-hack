# Changelog

All notable changes to Tally are documented here.

## [0.2.0] - 2026-10-12

### Added

- Direct runners for Claude Code and Codex (`runner: direct`), alongside the
  Agent Orchestrator runner, with setup, verification, metering and evidence
  recorded for each path.
- Opt-in parallel AO workers through `parallelWorkers` and `--parallel`.
- Trace-driven routing with model-keyed history and learned attempt ceilings.
- Failure classification via `failureAssessment` before escalation.
- Sponsor evidence links (Entire, Neatlogs and cfo.ai where available) on task
  pull requests, plus verified worker-trace read-back and ledger evidence.
- The CrustData `tally market` pilot-company report, including credential-free
  replay with `--replay`.
- The first-run logo animation and the `tally logo` replay command.
- A `tally doctor` readiness fix for locating and checking Agent Orchestrator.
- A refreshed onboarding flow covering direct/AO selection, Claude consent,
  optional Neatlogs, Entire and cfo.ai integrations, and GitHub/npm installs.
- Dashboard, demo, static publish and experiment improvements, including live
  spend, run selection, comparisons, code-graph slices and honest evidence
  labels; Entire checkpoints and cfo.ai budget/spend context are surfaced.

## [0.1.0] - 2026-10-10

### Added

- First release: route tasks by budget, cap attempts, escalate failures, verify
  repository changes, and open a pull request through Agent Orchestrator with
  Codex.
- A no-account scripted seven-task demo, local dashboard and run ledger, with
  `tally init`, `tally run`, `tally doctor` and configuration/secrets loading.
- Neatlogs trace and price-history adapters, file-backed history, checked-out
  worker worktrees, and traceable routing, ceilings and escalation decisions.
- Optional cfo.ai budgets/spend and Entire sizing, checkpoints and recall, plus
  GitHub issue intake, PR evidence and safe static dashboard publishing.

