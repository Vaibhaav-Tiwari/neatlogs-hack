# Scripted Code-Graph Fixture

Open the existing dashboard with `?data=graph-fixture/&replay=60&interval=250`.
Expand Code impact beneath a task. The fixture is explicitly sample data:
G1 is a single target, G2 stops then escalates and edits a file outside its
predicted slice, and G3 fails with a truncated 40-of-85-node slice.

Replay hides final changedFiles until the last attempt settles. The graph's
prediction remains constant while target markers and attempt history update.
Older data without impact renders no disclosure.

Run graph layout and replay tests with:
`npx vitest run --config dashboard/graph.test.config.mjs`.
