# Task 13b — WorkUnit budget and assignment gates

## Status

Implemented and verified. The reserve operation retains one atomic `INSERT ... SELECT ... WHERE ... ON CONFLICT DO NOTHING RETURNING *`; its assignment and policy conditions are enforced inside that statement. Diagnostic reads happen only after the insert returns no row.

## Changes

- `packages/swarmx/src/workunit/store.ts`
  - Added required explicit `workerAgent` to reserve and retry inputs and store it on newly reserved units.
  - Added policy v1 validation and atomic total, charged-per-cell iteration, configured-worker share, and assignment gates.
  - Retained legacy `budget_limit` as the total fallback when policy JSON is NULL. Malformed/unsupported policy now fails closed with `BudgetPolicyError` without exposing SQLite JSON errors.
  - Added typed `BudgetGateError` (`total`, `cell`, `share`), `AssignmentMismatchError`, and `BudgetPolicyError`. `BudgetExceededError` remains compatible as a total-gate subtype for legacy callers.
  - Added reserved-agent validation to bind and explicit agent propagation through retries; retries do not inherit `prior.worker_agent`.
  - Kept diagnostic precedence: mission/owner, same-call replay/conflict, idempotency, live cell, closed mission, then policy, assignment, total, cell, share.
- `packages/swarmx/tests/workunit-store.test.ts`
  - Added real in-memory libSQL coverage for each budget gate, zero-charge followups, charged terminal/revoked/legacy/retry history, share boundary/non-policy worker behavior, null-policy fallback, malformed/non-v1 policy, allowed and rejected assignment states, retry agent/gates, bind match/mismatch/no-write, and diagnostic precedence.
- `packages/swarmx/tests/workunit-migration.integration.test.ts`
  - Supplied the newly required explicit agent to its reservation call.

## RED/GREEN evidence

- RED: `bun test tests/workunit-store.test.ts -t 'budget|assignment|workerAgent|bind'` initially failed to load because the newly imported `AssignmentMismatchError` did not exist yet (`Export named 'AssignmentMismatchError' not found`). This confirmed the added tests could not pass against the pre-change implementation.
- RED after the initial implementation pass: the focused tests exposed four behavioral defects: share fixture incorrectly began with an over-share configured agent; reserve did not persist `worker_agent`; bind consequently saw a reserved NULL agent; and the retry test observed `worker_agent: null`. The fixture and implementation were corrected.
- GREEN: `bun test tests/workunit-store.test.ts -t 'budget|assignment|workerAgent|bind'` — 28 pass, 0 fail (413 assertions).
- Affected suite: `bun test tests/workunit-store.test.ts tests/mission-store.test.ts` — 44 pass, 0 fail (481 assertions).
- Full suite: first run concurrently with typecheck/build had two `reset-cli.test.ts` 5-second timeouts (441 pass, 5 skip, 2 fail). Isolated rerun `bun test tests/reset-cli.test.ts` passed (4 pass, 0 fail), then sequential full rerun `bun test tests/` passed (443 pass, 5 skip, 0 fail). After the final retry-budget assertion, focused and affected tests passed again, and final `bun test tests/` passed (443 pass, 5 skip, 0 fail; 4,131 assertions).
- `bun run typecheck` — passed (`tsc --noEmit`).
- `bun run build` — passed; emitted `dist/index.js` and `dist/bin/swarmx.js`. No tracked generated bundle or lockfile changes remained.

## Self-review

- Gates are expressed in the conditional reserve insert; no reserve gate uses read-then-write logic.
- Total/share sum all mission charges independent of unit state. Per-cell iteration counts only positive-charge units, including terminal, revoked, legacy, and retry units. Zero-charge incoming followups do not consume an iteration.
- Share uses the configured agent's charged total and the specified multiplicative boundary comparison, avoiding division by zero.
- Policy JSON parsing is guarded by `json_valid` in SQL; TypeScript then validates the complete v1 shape for deterministic typed diagnostics.
- Bind checks state, fence, and reserved agent in its update predicate; an agent mismatch is diagnosed after the failed conditional update and performs no write.
- Retry requires its own `workerAgent` and passes it through the same reserve gates.

## Concerns

No remaining implementation concerns identified. The first parallel full-suite run showed reset CLI timeouts under concurrent build/typecheck load; both the isolated reset tests and sequential full suite passed afterward.
