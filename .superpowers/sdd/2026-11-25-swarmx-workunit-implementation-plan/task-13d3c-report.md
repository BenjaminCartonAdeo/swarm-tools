# Task 13d3c — SQL cleanup locks and cancel-preserving reset

## Result

Implemented native WorkUnit cleanup locking and reset cancellation. Explicit legacy runtime overrides retain their KV cleanup claim and destructive reset path.

## RED/GREEN evidence

- **RED:** Before the implementation change, the focused runtime tests failed as expected: native cleanup did not create `cleanup:adeo` in `swarmx_locks`; the stale cleanup owner did not advance a fence because no native cleanup lock existed; reset left the native mission `OPEN`; and a non-owner session was not rejected by the legacy reset path.
- **GREEN:** After implementation, focused WorkUnit lock/reset/cleanup tests passed (7 runtime cases and 4 lock cases), followed by the affected test files and full package verification below.
- The exact stale-boundary and unheld-release lock cases were added against the existing Task 13d3a lock API. Existing lock tests already covered stale reclaim and stale-owner release; all four lock cases pass.

## Files changed

- `packages/swarmx/src/catalog.ts`
  - Native cleanup acquires `cleanup:${project}` through `acquireWorkUnitLock` with the five-minute stale window and releases with its exact token/fence.
  - Native reset resolves the mission and calls actor-checked `MissionCommands.cancel` using the owning coordinator session. Legacy reset behavior is unchanged.
- `packages/swarmx/src/dispatch.ts`
  - Native dispatch checks SQL lock activity and refuses dispatch while cleanup is active. The native path no longer reads the cleanup-claim KV key; the legacy dispatch path remains unchanged.
- `packages/swarmx/tests/runtime-smoke.test.ts`
  - Added coverage for native cleanup lock creation/contention, dispatch blocking and release, stale SQL lock expiry, stale-owner replacement protection, native reset history/ownership/drain barrier, and explicit legacy reset behavior.
- `packages/swarmx/tests/workunit-locks.test.ts`
  - Added exact stale-boundary reclaim and unheld-release no-op cases. Existing tests cover stale reclaim and stale-owner release.

## Verification

- RED command: `bun test tests/runtime-smoke.test.ts -t 'native cleanup|stale native cleanup|native reset|explicit legacy runtime override'` — 4 expected failures before implementation.
- Focused final cases: `bun test tests/runtime-smoke.test.ts -t 'native cleanup|expired SQL cleanup|stale native cleanup|native reset|explicit legacy runtime override'` — 7 passed.
- Lock boundary/ownership cases: `bun test tests/workunit-locks.test.ts -t 'exact stale boundary|unheld lock|stale reclaim|stale owner'` — 4 passed.
- Affected tests: `bun test tests/workunit-locks.test.ts tests/state-dispatch.test.ts tests/runtime-smoke.test.ts` — 218 passed, 1 skipped, 0 failed.
- Full package tests: `bun test tests/` — 527 passed, 5 skipped, 0 failed.
- Typecheck: `bun run typecheck` — passed (`tsc --noEmit`).
- Build: `bun run build` — passed; both `index.js` and `swarmx.js` bundles completed.
- No generated bundle changes were present in the scoped git status.

## Self-review

- Native dispatch/catalog cleanup paths use the SQL lock only; a deliberately seeded KV cleanup claim is ignored by native dispatch, while explicit legacy behavior is retained.
- Native lock release is constrained by both the random owner token and acquired fence, so completion of an expired owner cannot remove a reclaimed lock.
- Reset retains mission and unit rows; cancellation uses the actor-checked command and propagates the existing `MissionNotDrainedError` barrier rather than deleting lifecycle state.
- No coordinator tool routing or compaction behavior was changed. No lockfile, plan, or ledger was modified.

## Concerns

None identified. Verification passed on the final source and test changes.
