# Task 13a — WorkUnit mission state and projections

## Status

Implemented and verified. Scoped commit title: `feat(swarmx): project WorkUnit mission state`.

## RED/GREEN evidence

- **RED first:** after adding `mission-store.test.ts` and `projection.test.ts`, ran `bun test tests/mission-store.test.ts tests/projection.test.ts` from `packages/swarmx`. It failed before running assertions because the required production modules did not exist: `Cannot find module '../src/workunit/projection.js'` and `Cannot find module '../src/workunit/mission.js'` (0 passed, 2 failed, 2 errors). This confirmed the requested APIs were absent before implementation.
- After implementation, focused runs exposed test-fixture assumptions (expected worker-spawn count, the retry-retention boundary, and unique live-cell/idempotency constraints in the orphan fixture). The fixtures were corrected to match the stated all-unit counter and real schema constraints.
- **GREEN:** final focused run: 11 passed, 0 failed (33 assertions).
- **Affected suite:** 38 passed, 0 failed (461 assertions).
- **Full package test suite:** 428 passed, 5 skipped, 0 failed (4,094 assertions).
- **Typecheck:** `bun run typecheck` passed (`$ tsc --noEmit`).
- **Build:** `bun run build` passed; both package and CLI bundles completed. Build output did not add generated-file changes.
- **Diff hygiene:** `git diff --check` passed.

## Files changed

- `packages/swarmx/src/workunit/schema.ts` — exposed persisted mission mode and JSON fields on `Mission`.
- `packages/swarmx/src/workunit/store.ts` — renamed primary-key lookup to `getMissionByPk` and updated its internal callers.
- `packages/swarmx/src/workunit/mission.ts` — added mission creation/lookup/listing, policy validation and fenced mutations, retry-cause persistence, assignment upsert/release, and unit listing.
- `packages/swarmx/src/workunit/projection.ts` — added pure mission, cell, and orphan-candidate projections.
- `packages/swarmx/tests/mission-store.test.ts` — added in-memory database tests for mission persistence/lookup/listing, UUID generation, fencing, validation, conflict, assignment lifecycle, and unit listing.
- `packages/swarmx/tests/projection.test.ts` — added golden counter/budget, retry merge/cap, Hive/assignment/unit precedence, ready-cell selection, and display-only orphan ordering checks.
- `.superpowers/sdd/2026-11-25-swarmx-workunit-implementation-plan/task-13a-report.md` — this report.

## Self-review

- Mission changes use conditional `UPDATE ... WHERE id = ? AND fence = ? RETURNING *` statements; mutation success increments the fence and records `updated_at`.
- Mission creation uses a random UUID by default, the requested PK shape, and a typed conflict error for a live-session collision.
- Assignment release clears owner and agent while preserving the ledger row as `released`; projections ignore released assignments.
- Counters derive from WorkUnits, retry causes merge by `cellID|attempt|ts` with persisted duplicates taking precedence, and orphan selection is a pure ordered filter.
- No schema/index, package index, lockfile, plan, or ledger changes were made. No generated bundles remain modified.

## Concerns

None known. The build and all required test scopes passed.

## Round 1 fix (heavy)

- Medium attempt: test-first changes (5 regression tests RED then GREEN), focused 17 pass / affected 44 pass, but stopped on repeated `tsc` error `projection.ts(96,7): TS2322 Type 'unknown' is not assignable to type 'ConsolidationStatus'`; full suite 432 pass / 5 skip / 2 fail.
- Root cause: `isConsolidationStatus(parsed.status)` stored in `validStatus` does not narrow the `parsed.status` property at the return site. Fix: bind `const status = parsed.status`, guard `isConsolidationStatus(status)` inline, return `status`. No cast.
- Full-suite regressions: `runtime-smoke.test.ts` "local verification fallback closes and confirms the Hive cell" and "local fallback refuses approval when Hive remains in progress" (~16s each). Both passed after the typecheck fix with no further changes (`bun test tests/runtime-smoke.test.ts` → 89 pass 0 fail); they were downstream of the uncompilable projection module, not logic regressions.
- Findings status: (1) `getMissionByPk` single implementation in store.ts, re-exported from mission.ts; (2) assignments scoped by `assignment.mission_pk === mission.id`; (3) malformed consolidation omitted, policy fully validated incl. `workerShare` null/object with budget-limit fallback, malformed retry causes filtered.
- GREEN: `bun test tests/mission-store.test.ts tests/projection.test.ts tests/workunit-store.test.ts` → 44 pass 0 fail; `bun test tests/` → 434 pass 5 skip 0 fail; `bun run typecheck` clean; `bun run build` ok, no generated bundles left dirty.
- Self-review: minimal diff, no casts, no unrelated changes.
