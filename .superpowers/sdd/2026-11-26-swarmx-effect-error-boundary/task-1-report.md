# Task 1 Report: Capture Effect Execution Exceptions

## Result

Implemented an exception-to-outcome boundary in `runWorkUnitEffect`. Once an effect is successfully claimed, exceptions from `executeEffect` are converted with the existing `ambiguousOrDefinite` helper and passed to `recordEffectResult`:

- `DefiniteEffectError` is persisted as `failed_mandatory`.
- Any other thrown value is persisted as `unknown`.
- `recordEffectResult` clears the claim metadata as part of recording the outcome.

No public tool contract, timer, process-kill behavior, or unrelated code was changed.

## TDD evidence

Read `writing-good-tests.md` before modifying the test file. Added the three specified regression tests before production code:

1. `preCompletionReadFailureRecordsUnknownAndClearsClaim`
2. `definitePreCompletionReadFailureRecordsFailedMandatory`
3. `postCompletionReadFailureRetriesWithoutDuplicateSideEffect`

The first test invocation could not load `swarm-mail` because workspace dependencies were not installed. Ran `bun install --frozen-lockfile` at the monorepo root, then reran the focused test.

**RED — before the implementation:** `bun test tests/workunit-effects.integration.test.ts` reported `43 pass, 3 fail`. All three new tests failed because their `readHiveCell` exceptions escaped `runWorkUnitEffect` (pre-completion Error, pre-completion DefiniteEffectError, and post-completion Error).

**GREEN — after the implementation:** the same command reported `46 pass, 0 fail, 235 expect() calls`.

## Files changed

- `packages/swarmx/src/workunit/effects.ts` — catch execution exceptions, map via `ambiguousOrDefinite`, and record the outcome using the acquired claim token.
- `packages/swarmx/tests/workunit-effects.integration.test.ts` — add regression coverage for pre-read ambiguous/definite failures and post-completion reconciliation without a repeated backend call.

## Verification

Commands run from `packages/swarmx`:

- `bun test tests/workunit-effects.integration.test.ts`
  - Before implementation: `43 pass, 3 fail` (expected RED).
  - After implementation: `46 pass, 0 fail, 235 expect() calls`.
- `bun run typecheck`
  - Passed; output: `$ tsc --noEmit`.
  - A first attempt made concurrently with build was rejected because another build/test was running; rerunning after build completed passed.
- `bun run build`
  - Passed; bundled `index.js` (0.34 MB) and `bin/swarmx.js` (159.50 KB).

Git status after verification showed only the two intended source and test files modified; no generated bundle changes were present.

## Self-review

- The handler is after the successful claim and before the existing `recordEffectResult` call, so thrown execution errors now reach the journal outcome write.
- Existing mapping and error serialization helpers are reused; the implementation adds no duplicate classification logic.
- The retry regression confirms the first attempt records `unknown`, the second reconciles the matching closed cell, and `swarm_complete` is called exactly once.
- The tests assert the persisted state/error and cleared claim token rather than inspecting internal control flow.

## Concerns

Database errors thrown by `recordEffectResult` remain errors and are not swallowed; this is intentional because the requested boundary is around effect execution, and a failed journal write cannot be represented as a durably recorded outcome.

## Commit

Requested commit message: `fix(swarmx): record effect execution failures`.
