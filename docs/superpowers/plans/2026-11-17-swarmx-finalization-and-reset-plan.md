# Swarmx Finalization and Reset Scope Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Keep Hive status, swarmx approval state, and mission cleanup consistent without allowing one session to delete another session's state.

**Architecture:** Run backend CLI tools in the canonical project root and include the explicit project scope on Hive reads. If `swarm_complete` cannot find a cell and local verification is used, close that cell only after verification passes, then read Hive back and require a terminal status before approving. Tag new assignments with their owning session; reset and finish remove only that session's attempts and assignments. Unreviewed attempts remain a finish blocker; no generic revoke bypass is added.

**Tech Stack:** TypeScript, Bun tests, swarmx V2 plugin and its local mission store.

**Spec:** The consolidation-dependency plan and follow-up findings supplied in the session.

## Global Constraints

- Do not commit or push until explicitly authorized; that authorization arrived after implementation.
- Preserve existing uncommitted changes; modify only the required lines and tests.
- Follow TDD: each regression test must fail for the intended reason before its fix.
- Keep `swarm_finish` blocked for pending or unreviewed worker attempts.
- Hive closure through the local-verification fallback is permitted only after the scoped review and local verification pass.
- Do not use project-wide deletion for attempts or assignments.

## Review Focus

- A local-verification fallback must not approve a cell while Hive still reports it in progress.
- Hive reads, creation, and closure must use the active canonical project rather than the OpenCode process's incidental cwd.
- Resetting one session must preserve another session's mission, attempt ledger, and assignment.
- A stale assignment owned by another session must not satisfy the dispatch assignment gate.
- An unreviewed attempt must continue to prevent mission finish; no administrative revoke path may bypass review.

---

### Task 1: Keep Hive finalization aligned with approval

**Files:**
- Modify: `packages/swarmx/src/catalog.ts`
- Test: `packages/swarmx/tests/runtime-smoke.test.ts`

**Interfaces:**
- `SwarmxRuntime.projectPath` is the canonical project root.
- `runToolForSession` passes the canonical project root as CLI `cwd` when available.
- `listEpicChildCells` sends `project_key` along with `parent_id`.

- [x] **Step 1: Write a failing runtime test**

Add a test where backend `swarm_complete` returns `Bead not found`, local verification passes, and `hive_cells` initially reports the assigned cell as `in_progress`. Assert swarmx calls `hive_close` in the canonical project context, re-reads the epic children, and refuses approval if Hive does not report that cell as `closed`/`completed`/`done`.

- [x] **Step 2: Run the test and confirm the expected failure**

Run: `bun test packages/swarmx/tests/runtime-smoke.test.ts`

Expected: the regression fails because the fallback currently marks completion locally without closing/verifying Hive, and backend calls omit a cwd.

- [x] **Step 3: Implement the minimum safe finalization path**

Pass `runtime.projectPath` as `cwd` for backend CLI calls. Include it as `project_key` for epic-child Hive queries. After a successful local verification fallback, call `hive_close`, query the same project's epic children again, and require a terminal Hive status before persisting completion/approval. On failure, clear the `finalizing` marker and leave the completion pending.

- [x] **Step 4: Re-run the regression test**

Run: `bun test packages/swarmx/tests/runtime-smoke.test.ts`

Expected: PASS, including a failure case where Hive closure/readback fails.

### Task 2: Scope reset and assignment cleanup to the owning session

**Files:**
- Modify: `packages/swarmx/src/state.ts`
- Modify: `packages/swarmx/src/dispatch.ts`
- Modify: `packages/swarmx/src/catalog.ts`
- Test: `packages/swarmx/tests/state-dispatch.test.ts`
- Test: `packages/swarmx/tests/prompts.test.ts`

**Interfaces:**
- `setAssignment` accepts an optional `{ sessionID: string }` owner.
- `resolveAssignment` accepts the expected owner and rejects a different owned session; legacy unowned entries remain readable.
- Reset/finish remove only assignment entries whose recorded owner matches the session being closed.

- [x] **Step 1: Write failing isolation tests**

Seed two sessions in the same project with distinct attempts and owned assignments. Reset one session and assert its mission, attempts, and assignments are removed while the other session's entries remain. Assert that an assignment owned by another session cannot satisfy the dispatch gate.

- [x] **Step 2: Run the tests and confirm the expected failure**

Run: `bun test packages/swarmx/tests/state-dispatch.test.ts packages/swarmx/tests/prompts.test.ts`

Expected: FAIL because reset currently scans and deletes every project attempt and assignment.

- [x] **Step 3: Implement session ownership and scoped cleanup**

Write ownership metadata when catalog tools persist assignments. Filter attempt deletion by `sessionID`; delete only assignments tagged with the reset/finished session. Preserve unowned legacy records because their owner cannot be established safely.

- [x] **Step 4: Re-run the isolation tests**

Run: `bun test packages/swarmx/tests/state-dispatch.test.ts packages/swarmx/tests/prompts.test.ts`

Expected: PASS; another session's records remain intact.

### Task 3: Reject hollow verification receipts

**Files:**
- Modify: `packages/swarmx/src/catalog.ts`
- Test: `packages/swarmx/tests/runtime-smoke.test.ts`

**Interfaces:**
- `parseCompletionVerificationReceipt` accepts at least one executed step and rejects any failed executed step.
- `runLocalVerification` returns `passed: false` when every step is skipped.
- A doc-only completion may proceed as `unverifiable` after review; its Hive cell still must be closed and read back.

- [x] **Step 1: Write failing runtime tests**

Cover a backend receipt with all steps skipped, a local fallback with no applicable checks, and a doc-only fallback accepted as `unverifiable` only after review and Hive readback.

- [x] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/swarmx/tests/runtime-smoke.test.ts`

Expected: all-skipped backend/local gates currently appear successful; the doc-only case must remain an explicit exception.

- [x] **Step 3: Implement fail-closed parsing and local verification**

Require at least one executed verification step. Do not close Hive for an unverified code cell; retain the reviewed doc-only `unverifiable` path and verify its Hive closure.

- [x] **Step 4: Re-run the runtime tests**

Run: `bun test packages/swarmx/tests/runtime-smoke.test.ts`

Expected: PASS; skipped-only code verification is blocked, while doc-only review is explicitly unverifiable.

### Final verification

- [x] Run `bun test packages/swarmx` and confirm zero failures.
- [x] Run `bun run --cwd packages/swarmx typecheck` and `bun run --cwd packages/swarmx build`.
- [x] Install and check the local plugin with `node packages/swarmx/dist/bin/swarmx.js install --target /home/benjamin/Dev/.opencode` and `node packages/swarmx/dist/bin/swarmx.js doctor --target /home/benjamin/Dev/.opencode`.
- [x] Review `git diff --check` and `git status`; make no commit or push.
