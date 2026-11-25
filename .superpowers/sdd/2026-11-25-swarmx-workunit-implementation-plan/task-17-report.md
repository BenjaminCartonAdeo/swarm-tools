# Task 17 — WorkUnit process fencing verification

## Status

Implemented the four requested real two-process races. No store defect was reproduced, so no production-store changes were needed. `tests/helpers.ts` remains unchanged.

## Files

- `packages/swarmx/tests/workunit-multiprocess.integration.test.ts` — four named integration tests, unique `/tmp/opencode` database directories, seed/inspection helpers, child readiness markers, a parent start gate, bounded waits, JSON parsing, child termination/awaiting, and recursive cleanup.
- `packages/swarmx/tests/fixtures/workunit-race-child.ts` — independent Bun child entrypoint. Each child creates its own `createLibSQLAdapter({ url: \`file:${dbPath}\` })`, initializes schema, writes its ready marker, waits for the start file, performs its operation, writes one JSON result to stdout, and sends diagnostics to stderr.

## Race assertions

- `twoProcessesRaceForOneLiveCellUnit` — exactly one reservation wins; the loser reports `CellBusyError`; the database contains one live unit and one live cell.
- `twoProcessesRaceForLastBudgetUnit` — two individually affordable charges compete for a total budget of 3; exactly one reservation wins, the loser reports `BudgetGateError`, and `getMissionBudgetUsed` returns 2.
- `twoProcessesRaceSameFence` — two transitions use the same RESERVED/fence-1 input; exactly one wins, the loser reports `FenceConflictError`, and the stored unit is BOUND at fence 2.
- `missionCloseRacesReserve` — a complete close operation races a reservation; exactly one operation wins. The test drains a reservation if it preceded close, finishes the close, and verifies a terminal mission has no live units.

## Verification evidence

Three independent consecutive runs of the focused test after the final harness changes:

1. `bun test tests/workunit-multiprocess.integration.test.ts` — 4 pass, 0 fail, 26 expectations (1.53s).
2. `bun test tests/workunit-multiprocess.integration.test.ts` — 4 pass, 0 fail, 26 expectations (1.52s).
3. `bun test tests/workunit-multiprocess.integration.test.ts` — 4 pass, 0 fail, 26 expectations (1.50s).

Additional required checks, after the final test changes:

- `bun test tests/workunit-multiprocess.integration.test.ts tests/workunit-store.test.ts` — 45 pass, 0 fail, 495 expectations.
- `bun test tests/` — 452 pass, 5 skipped, 0 fail; 457 tests across 24 files.
- `bun run typecheck` — passed (`$ tsc --noEmit`).
- `bun run build` — passed; bundled 22 modules for `index.js` and 13 modules for `swarmx.js`.
- `git diff --check` — passed.

## Self-review and concerns

- The tests use direct per-child file adapters and do not add process-local locks, cached adapters, changes to `tests/helpers.ts`, or store changes.
- Parent cleanup kills any child still alive, awaits all child exits and output streams, closes the inspection adapter, then removes the unique temporary directory.
- Initial harness runs exposed two test-harness mistakes (default test timeout shorter than the bounded process wait, and treating the close result's mission ID as a WorkUnit ID); both were corrected. A later run also observed a transient ready-marker timeout. The readiness bound was increased to 20 seconds and child early-exit diagnostics now include stderr. The three consecutive final runs and all required suites passed afterward.
- No store failure was observed; the one transient startup timeout remains a harness flakiness concern worth watching if it recurs. Child readiness, child start-gate, and process-exit waits all remain bounded.
- The build's `dist` output is not tracked by Git (`git restore packages/swarmx/dist` reported that the path is unknown to Git); the pre-commit Git status contained only the requested untracked test files, not generated bundles.

## Commit

Requested commit message: `test(swarmx): verify WorkUnit process fencing`
