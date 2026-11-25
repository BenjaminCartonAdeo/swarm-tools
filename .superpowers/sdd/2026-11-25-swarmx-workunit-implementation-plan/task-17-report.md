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

## Fix round 1 — Pin close-race loser errors

### Contract verified

The exported store implementations establish two legal outcomes for this race:

- If close wins, `beginMissionClose` moves the mission through CLOSING and `finishMissionClose` completes it. The losing `reserveWorkUnit` cannot insert because reservations require OPEN and its diagnostic path throws `MissionClosedError` (`store.ts:332, 398–428`).
- If reservation wins, `beginMissionClose` can still move the mission to CLOSING, but `finishMissionClose` sees the live WorkUnit and throws `MissionNotDrainedError` (`store.ts:585–601, 633–656`).
- `beginMissionClose` may throw `MissionFenceConflictError` for a stale fence/owner/state, but the race fixture supplies the current fence and owner and has no competing closer. That is not a legal loser outcome for these two operations.

### Change and characterization

Strengthened `missionCloseRacesReserve` to select the expected loser error from the winner's result: a closer winner requires `MissionClosedError`; a reserver winner requires `MissionNotDrainedError`. These are exact serialized error names from the child process, so infrastructure failures such as `SQLITE_BUSY` are rejected. The assertion passed immediately against the existing store and is a characterization of its intended race contract. No production code, fault-injection switch, or additional named test was added.

### Verification evidence

Three consecutive focused runs after the assertion change:

1. `bun test tests/workunit-multiprocess.integration.test.ts` — 4 pass, 0 fail, 27 expectations (1.53s).
2. `bun test tests/workunit-multiprocess.integration.test.ts` — 4 pass, 0 fail, 27 expectations (1.51s).
3. `bun test tests/workunit-multiprocess.integration.test.ts` — 4 pass, 0 fail, 27 expectations (1.56s).

Required checks:

- `bun test tests/workunit-multiprocess.integration.test.ts tests/workunit-store.test.ts` — 45 pass, 0 fail, 496 expectations.
- `bun test tests/` — 452 pass, 5 skipped, 0 fail; 457 tests across 24 files.
- `bun run typecheck` — passed (`$ tsc --noEmit`).
- `bun run build` — passed; bundled 22 modules for `index.js` and 13 modules for `swarmx.js`.

### Files and self-review

- Changed `packages/swarmx/tests/workunit-multiprocess.integration.test.ts` and this report only.
- The branch preserves both legal race orderings and asserts the exact named typed loser for whichever ordering occurs. A generic/infrastructure error cannot satisfy either expected string.
- `tests/helpers.ts`, the child fixture, store code, plan/ledger, and lockfiles were not changed in this round.
- Build output remains ignored/untracked as established in the initial report; no generated bundle is part of the change.

### Commit

Requested commit message: `test(swarmx): pin close race loser errors`
