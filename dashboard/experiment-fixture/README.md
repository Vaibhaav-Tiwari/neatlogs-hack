# Scripted Experiment Comparison

Serve the repository and open the existing dashboard with
`?data=experiment-fixture/sample-tally-1/&runsIndex=experiment-fixture/index.json`.
The fixture follows experiment-summary-spec.md and labels all workers and
costs simulated. It deliberately shows Tally costing more and passing fewer
tasks than baseline. Both modes have two repeats.

The page reads the indexed summary every poll. Summary status may be running,
finished or stopped; missing/invalid/incompatible summaries use the existing
per-run fallback, restricted to matching repository, task ids and data kind.
An explicit `?experiment=path/to/summary.json` selects a compatible summary.
Replay views retain per-run figures instead of comparing a partial replay
against finished experiment results.

Tests: `npx vitest run --config dashboard/experiment.test.config.mjs`.
