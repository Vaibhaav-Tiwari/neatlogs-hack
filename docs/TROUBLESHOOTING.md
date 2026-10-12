# Troubleshooting by failure message

These are the messages Tally prints for common setup, planning, and integration failures.

## Agent Orchestrator project

### Recorded project was deleted

**Message:** `ao command failed (1); check the command in your terminal before retrying.`

**Meaning:** The recorded AO project is no longer available, so Tally cannot use the configured worker project.

**Fix:** Start AO, verify the project with `ao project get <id>`, or rerun `tally init` to record a current project.

### Clone path changed

**Message:** `AO project <id> belongs to <path>, not <repoRoot>; choose a distinct project id before init; nothing was changed.`

**Meaning:** The AO project is registered to a different path, commonly because the repository was renamed or this is a nested clone.

**Fix:** Run init from the registered clone, or choose a distinct AO project ID and rerun `tally init` from the intended repository root.

## Configuration and verification

### Configuration is missing

**Message:** `tally.yaml: file not found; run \`tally init\` to create it`

**Meaning:** Tally was run in a repository without its configuration file.

**Fix:** Run `tally init` in the repository root, then review and apply the detected configuration.

### No verification command

**Message:** `No test command found. Tally cannot verify work without a test command. Provide a shell command that checks the work. No configuration or AO settings have been changed.`

**Meaning:** Init could not detect a command that verifies the repository.

**Fix:** Rerun init interactively or provide `--test-command '<command>'` with the real check for the repository.

## Workers and budgets

### Agent is missing or signed out

**Messages:** `claude is not installed or could not run.` / `codex is not installed or could not run.`; `claude is signed out or its sign-in status could not be verified.` / `codex is signed out or its sign-in status could not be verified.`

**Meaning:** The selected coding-agent CLI is unavailable or its CLI-reported login status is not usable.

**Fix:** Install the selected CLI, then run `claude auth login` or `codex login`. Run `tally doctor`; Tally does not substitute another harness.

### Claude Code consent is missing

**Message:** `Claude Code worker consent is missing (claudeCode.allow); run tally init to review and approve its allow-list before starting a worker.`

**Meaning:** The config has no approved Claude Code allow-list for the worker.

**Fix:** Rerun `tally init`, review the displayed test/setup scripts and approve the allow-list.

### Reservation cannot fit

**Message:** `not started: reservation does not fit the run cap and monthly budget`

**Meaning:** The task's reservation, including its possible next-tier escalation, exceeds available run-cap or monthly budget.

**Fix:** Use a larger `--budget`, reduce parallel reservations, or wait for monthly budget to become available. Do not expect this task to start in the current run.

## Integrations

### Entire has no matching symbols

**Message:** `No code symbols matched this task; sized by repository search.`

**Meaning:** Entire's graph returned no code symbols for the task; Tally used repository search instead.

**Fix:** Usually no action is required. Improve the task's file/symbol references if graph-based sizing is expected; otherwise continue with the repository-search estimate.

### cfo.ai budget read timed out

**Message:** `cfo.ai budget read failed: <underlying timeout message>; using the fallback budget in tally.yaml`

**Meaning:** Tally could not read the configured cfo.ai budget before the provider operation timed out, so it used the local fallback budget.

**Fix:** Run `tally doctor` and `tally login cfoai`, check connectivity and cfo.ai access, then retry. For a parallel paid AO run, restore cfo.ai access or run sequentially with `--parallel 1`.
