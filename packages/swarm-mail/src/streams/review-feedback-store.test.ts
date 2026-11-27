import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibSQLAdapter } from "../libsql.js";
import type { DatabaseAdapter } from "../types/database.js";
import { createEvent } from "./events.js";
import { createLibSQLStreamsSchema } from "./libsql-schema.js";
import {
  claimReviewFeedback,
  completeReviewFeedback,
  markReviewFeedbackStarted,
  recoverReviewFeedbackOperation,
  recoverStaleReviewFeedback,
  releaseReviewFeedbackClaim,
  getDurableReviewApproval,
  type ReviewFeedbackResult,
} from "./review-feedback-store.js";
import { appendEvent } from "./store-drizzle.js";
import { appendEvent as appendEventLegacy } from "./store.js";
import { sendSwarmMessage } from "./swarm-mail.js";

const PROJECT = "/tmp/review-feedback-project";

function claimInput(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    projectKey: PROJECT,
    taskId: "task-1",
    workerId: "worker-1",
    requestHash: "hash-a",
    status: "needs_changes" as const,
    hostInstanceId: "host-instance-A",
    hostname: "host-a",
    pid: 1111,
    ...overrides,
  };
}

const RESULT: ReviewFeedbackResult = {
  success: true,
  status: "needs_changes",
  task_id: "task-1",
  attempt: 1,
};

describe("review feedback operations", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseAdapter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "review-feedback-store-"));
    dbPath = join(dir, "swarm.db");
    db = await createLibSQLAdapter({ url: `file:${dbPath}` });
    await createLibSQLStreamsSchema(db);
  });

  afterEach(async () => {
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  test("replayedFeedbackOperationReturnsSavedResult", async () => {
    const first = await claimReviewFeedback(claimInput("op-replay"), db);
    if (first.kind !== "claimed") throw new Error(`expected claimed, got ${first.kind}`);
    await markReviewFeedbackStarted("op-replay", first.claimToken, db);
    await completeReviewFeedback("op-replay", first.claimToken, RESULT, db);

    const replay = await claimReviewFeedback(claimInput("op-replay"), db);
    expect(replay).toEqual({ kind: "done", result: RESULT });
  });

  test("concurrentSameOperationIdIncrementsAttemptOnce", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimReviewFeedback(claimInput("op-race"), db)),
    );
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "busy")).toHaveLength(4);
    expect(results.map((r) => ("attempt" in r ? r.attempt : -1))).toEqual([1, 1, 1, 1, 1]);

    const next = await claimReviewFeedback(claimInput("op-race-2"), db);
    expect(next.kind === "claimed" && next.attempt).toBe(2);
  });

  test("concurrentDuplicateGetsBusyWithoutOwnerToken", async () => {
    const owner = await claimReviewFeedback(claimInput("op-busy"), db);
    expect(owner.kind).toBe("claimed");
    const dup = await claimReviewFeedback(claimInput("op-busy", { pid: 2222 }), db);
    expect(dup).toEqual({ kind: "busy", attempt: 1 });
  });

  test("attemptNumberSurvivesProcessRestart", async () => {
    const a = await claimReviewFeedback(claimInput("op-r1"), db);
    if (a.kind !== "claimed") throw new Error("expected claimed");
    await completeReviewFeedback("op-r1", a.claimToken, RESULT, db);
    await db.close?.();

    db = await createLibSQLAdapter({ url: `file:${dbPath}` });
    await createLibSQLStreamsSchema(db);
    const b = await claimReviewFeedback(claimInput("op-r2", { pid: 3333 }), db);
    expect(b.kind === "claimed" && b.attempt).toBe(2);
    const approved = await claimReviewFeedback(
      claimInput("op-r3", { status: "approved", pid: 3333 }),
      db,
    );
    expect(approved.kind === "claimed" && approved.attempt).toBe(2);
  });

  test("crashAfterClaimDoesNotLoseOperation", async () => {
    const owner = await claimReviewFeedback(claimInput("op-crash"), db);
    if (owner.kind !== "claimed") throw new Error("expected claimed");
    await markReviewFeedbackStarted("op-crash", owner.claimToken, db);
    await db.close?.();

    db = await createLibSQLAdapter({ url: `file:${dbPath}` });
    const afterRestart = await claimReviewFeedback(claimInput("op-crash", { pid: 4444 }), db);
    expect(afterRestart).toEqual({ kind: "busy", attempt: 1 });
    const rows = await db.query<{ state: string; attempt: number }>(
      "SELECT state, attempt FROM review_feedback_operations WHERE operation_id = 'op-crash'",
    );
    expect(rows.rows).toEqual([{ state: "in_progress", attempt: 1 }]);
  });

  test("sameHostDeadPidClaimRecovers", async () => {
    const dead = await claimReviewFeedback(claimInput("op-dead", { pid: 5555 }), db);
    if (dead.kind !== "claimed") throw new Error("expected claimed");
    await markReviewFeedbackStarted("op-dead", dead.claimToken, db);

    const liveOnly = await recoverStaleReviewFeedback(
      { hostname: "host-a", isProcessAlive: () => true },
      db,
    );
    expect(liveOnly).toEqual({ recovered: 0, foreignCandidates: [], recoveredOperations: [] });

    const recovery = await recoverStaleReviewFeedback(
      { hostname: "host-a", isProcessAlive: (pid) => pid !== 5555 },
      db,
    );
    expect(recovery).toEqual({ recovered: 1, foreignCandidates: [], recoveredOperations: ["op-dead"] });

    const retaken = await claimReviewFeedback(claimInput("op-dead", { pid: 6666 }), db);
    if (retaken.kind !== "claimed") throw new Error(`expected claimed, got ${retaken.kind}`);
    expect(retaken.attempt).toBe(1);
    expect(retaken.claimToken).not.toBe(dead.claimToken);
    await expect(
      completeReviewFeedback("op-dead", dead.claimToken, RESULT, db),
    ).rejects.toThrow(/stale/i);
  });

  test("liveForeignHostClaimRequiresExplicitRecovery", async () => {
    const foreign = await claimReviewFeedback(
      claimInput("op-foreign", { hostname: "host-b", hostInstanceId: "host-instance-B", pid: 7777 }),
      db,
    );
    expect(foreign.kind).toBe("claimed");
    let pidChecks = 0;
    const recovery = await recoverStaleReviewFeedback(
      {
        hostname: "host-a",
        isProcessAlive: () => {
          pidChecks++;
          return false;
        },
      },
      db,
    );
    expect(recovery).toEqual({ recovered: 0, foreignCandidates: ["op-foreign"], recoveredOperations: [] });
    expect(pidChecks).toBe(0);
    expect(await claimReviewFeedback(claimInput("op-foreign"), db)).toEqual({
      kind: "busy",
      attempt: 1,
    });

    expect(await recoverReviewFeedbackOperation("op-foreign", db)).toBe(true);
    const retaken = await claimReviewFeedback(claimInput("op-foreign"), db);
    expect(retaken.kind === "claimed" && retaken.attempt).toBe(1);
  });

  // Break: stale/explicit recovery ignoring projectKey and releasing another project's claim.
  test("recoverProjectFilterDoesNotTouchOtherProjects", async () => {
    const mine = await claimReviewFeedback(claimInput("op-mine", { pid: 5555 }), db);
    const other = await claimReviewFeedback(
      claimInput("op-other", { projectKey: "/tmp/other-project", pid: 5555 }),
      db,
    );
    const foreignOther = await claimReviewFeedback(
      claimInput("op-foreign-other", { projectKey: "/tmp/other-project", hostname: "host-b" }),
      db,
    );
    expect([mine.kind, other.kind, foreignOther.kind]).toEqual(["claimed", "claimed", "claimed"]);

    const recovery = await recoverStaleReviewFeedback(
      { hostname: "host-a", isProcessAlive: () => false, projectKey: PROJECT },
      db,
    );
    expect(recovery).toEqual({ recovered: 1, foreignCandidates: [], recoveredOperations: ["op-mine"] });
    expect(await claimReviewFeedback(claimInput("op-other", { projectKey: "/tmp/other-project" }), db))
      .toEqual({ kind: "busy", attempt: 1 });

    expect(await recoverReviewFeedbackOperation("op-other", db, PROJECT)).toBe(false);
    expect(await recoverReviewFeedbackOperation("op-other", db, "/tmp/other-project")).toBe(true);
  });

  test("staleClaimTokenCannotCompleteFeedback", async () => {
    const owner = await claimReviewFeedback(claimInput("op-stale"), db);
    if (owner.kind !== "claimed") throw new Error("expected claimed");
    await expect(completeReviewFeedback("op-stale", "not-the-token", RESULT, db)).rejects.toThrow(
      /stale/i,
    );
    await expect(markReviewFeedbackStarted("op-stale", "not-the-token", db)).rejects.toThrow(
      /stale/i,
    );
    await completeReviewFeedback("op-stale", owner.claimToken, RESULT, db);
    await expect(
      completeReviewFeedback("op-stale", owner.claimToken, { ...RESULT, attempt: 99 }, db),
    ).rejects.toThrow(/stale/i);
    expect(await claimReviewFeedback(claimInput("op-stale"), db)).toEqual({
      kind: "done",
      result: RESULT,
    });
  });

  test("operationIdReusedForDifferentRequestIsRejected", async () => {
    await claimReviewFeedback(claimInput("op-hash"), db);
    await expect(
      claimReviewFeedback(claimInput("op-hash", { requestHash: "hash-b" }), db),
    ).rejects.toThrow(/operation_id/);
  });

  test("operationKeyedEventAndMessageAreWrittenOnce", async () => {
    const event = () =>
      createEvent("review_completed", {
        project_key: PROJECT,
        epic_id: "epic-1",
        bead_id: "task-1",
        status: "approved",
        attempt: 1,
        operation_id: "op-side",
      });
    const first = await appendEvent(event(), PROJECT, db);
    const second = await appendEvent(event(), PROJECT, db);
    expect(second.id).toBe(first.id);
    const events = await db.query<{ n: number }>(
      "SELECT COUNT(id) AS n FROM events WHERE operation_id = 'op-side'",
    );
    expect(events.rows[0]?.n).toBe(1);

    const send = () =>
      sendSwarmMessage({
        projectPath: PROJECT,
        fromAgent: "coordinator",
        toAgents: ["worker-1"],
        subject: "APPROVED: task-1",
        body: "ok",
        threadId: "epic-1",
        operationId: "op-side:worker-message",
        dbOverride: db,
      });
    const m1 = await send();
    const m2 = await send();
    expect(m2.messageId).toBe(m1.messageId);
    expect(m1.duplicate ?? false).toBe(false);
    expect(m2.duplicate).toBe(true);
    const messages = await db.query<{ n: number }>(
      "SELECT COUNT(id) AS n FROM messages WHERE operation_id = 'op-side:worker-message'",
    );
    expect(messages.rows[0]?.n).toBe(1);
    const recipients = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?",
      [m1.messageId],
    );
    expect(recipients.rows[0]?.n).toBe(1);
    const sentEvents = await db.query<{ n: number }>(
      "SELECT COUNT(id) AS n FROM events WHERE type = 'message_sent'",
    );
    expect(sentEvents.rows[0]?.n).toBe(1);
  });
  test("failedSideEffectReleasesClaimForSafeRetry", async () => {
    const owner = await claimReviewFeedback(claimInput("op-fail"), db);
    if (owner.kind !== "claimed") throw new Error("expected claimed");
    await markReviewFeedbackStarted("op-fail", owner.claimToken, db);
    // Same live process retries before release: busy
    expect(await claimReviewFeedback(claimInput("op-fail"), db)).toEqual({ kind: "busy", attempt: 1 });

    await releaseReviewFeedbackClaim("op-fail", owner.claimToken, db);
    const retry = await claimReviewFeedback(claimInput("op-fail"), db);
    if (retry.kind !== "claimed") throw new Error(`expected claimed, got ${retry.kind}`);
    expect(retry.attempt).toBe(1);
    await expect(completeReviewFeedback("op-fail", owner.claimToken, RESULT, db)).rejects.toThrow(/stale/i);
    await completeReviewFeedback("op-fail", retry.claimToken, RESULT, db);
    expect(await claimReviewFeedback(claimInput("op-fail"), db)).toEqual({ kind: "done", result: RESULT });
    const next = await claimReviewFeedback(claimInput("op-fail-next"), db);
    expect(next.kind === "claimed" && next.attempt).toBe(2);
  });

  test("durableApprovalReflectsLatestCompletedFeedback", async () => {
    expect(await getDurableReviewApproval(PROJECT, "task-1", db)).toBe(false);
    const a = await claimReviewFeedback(claimInput("op-ap", { status: "approved" }), db);
    if (a.kind !== "claimed") throw new Error("expected claimed");
    expect(await getDurableReviewApproval(PROJECT, "task-1", db)).toBe(false);
    await completeReviewFeedback("op-ap", a.claimToken, { ...RESULT, status: "approved" }, db);
    expect(await getDurableReviewApproval(PROJECT, "task-1", db)).toBe(true);
    expect(await getDurableReviewApproval(PROJECT, "task-2", db)).toBe(false);
    expect(await getDurableReviewApproval("/other", "task-1", db)).toBe(false);
    const n = await claimReviewFeedback(claimInput("op-nc"), db);
    if (n.kind !== "claimed") throw new Error("expected claimed");
    await completeReviewFeedback("op-nc", n.claimToken, RESULT, db);
    expect(await getDurableReviewApproval(PROJECT, "task-1", db)).toBe(false);
  });

  test("keyedMessageProjectionLostByCrashIsRepairedOnReplay", async () => {
    const send = () =>
      sendSwarmMessage({
        projectPath: PROJECT,
        fromAgent: "coordinator",
        toAgents: ["worker-1"],
        subject: "APPROVED: task-1",
        body: "ok",
        operationId: "op-crash-msg",
        dbOverride: db,
      });
    await send();
    // Simulate a crash after the event insert but before the projection ran
    await db.query("DELETE FROM message_recipients");
    await db.query("DELETE FROM messages WHERE operation_id = 'op-crash-msg'");

    const replay = await send();
    expect(replay.messageId).toBeGreaterThan(0);
    const rows = await db.query<{ n: number }>(
      "SELECT COUNT(id) AS n FROM messages WHERE operation_id = 'op-crash-msg'",
    );
    expect(rows.rows[0]?.n).toBe(1);
    const recipients = await db.query<{ agent_name: string }>(
      "SELECT agent_name FROM message_recipients WHERE message_id = ?",
      [replay.messageId],
    );
    expect(recipients.rows.map((r) => r.agent_name)).toEqual(["worker-1"]);
    const events = await db.query<{ n: number }>(
      "SELECT COUNT(id) AS n FROM events WHERE type = 'message_sent'",
    );
    expect(events.rows[0]?.n).toBe(1);

    // Message present but recipients lost: replay restores recipients only
    await db.query("DELETE FROM message_recipients");
    const again = await send();
    expect(again.messageId).toBe(replay.messageId);
    expect(again.duplicate).toBe(true);
    const restored = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM message_recipients");
    expect(restored.rows[0]?.n).toBe(1);
  });
  test("durableStatusFollowsCompletionOrderNotInsertionOrAttempt", async () => {
    const cases: Array<["needs_changes" | "approved", boolean]> = [
      ["needs_changes", false],
      ["approved", true],
    ];
    for (const [lastStatus, expected] of cases) {
      const taskId = `task-order-${lastStatus}`;
      const firstStatus = lastStatus === "approved" ? "needs_changes" : "approved";
      // Inserted (claimed) first, completed last
      const early = await claimReviewFeedback(
        claimInput(`${taskId}-early`, { taskId, status: lastStatus }),
        db,
      );
      // Inserted second, completed first
      const late = await claimReviewFeedback(
        claimInput(`${taskId}-late`, { taskId, status: firstStatus }),
        db,
      );
      if (early.kind !== "claimed" || late.kind !== "claimed") throw new Error("expected claims");
      expect(early.attempt).toBe(1);
      expect(late.attempt).toBe(1);
      await completeReviewFeedback(
        `${taskId}-late`,
        late.claimToken,
        { success: true, status: firstStatus, task_id: taskId },
        db,
      );
      await completeReviewFeedback(
        `${taskId}-early`,
        early.claimToken,
        { success: true, status: lastStatus, task_id: taskId },
        db,
      );
      // Identical updated_at: timestamps must not decide
      await db.query("UPDATE review_feedback_operations SET updated_at = 1000 WHERE task_id = ?", [
        taskId,
      ]);
      expect(await getDurableReviewApproval(PROJECT, taskId, db)).toBe(expected);
      const seqs = await db.query<{ operation_id: string; completion_seq: number }>(
        "SELECT operation_id, completion_seq FROM review_feedback_operations WHERE task_id = ? ORDER BY completion_seq",
        [taskId],
      );
      expect(seqs.rows).toEqual([
        { operation_id: `${taskId}-late`, completion_seq: 1 },
        { operation_id: `${taskId}-early`, completion_seq: 2 },
      ]);
    }
  });

  for (const [label, append] of [
    ["drizzle", (e: Parameters<typeof appendEvent>[0]) => appendEvent(e, PROJECT, db)],
    ["legacy", (e: Parameters<typeof appendEvent>[0]) => appendEventLegacy(e, PROJECT, db)],
  ] as const) {
    test(`concurrentRepairLoserEnsuresWinnerRecipients (${label})`, async () => {
      const event = () =>
        createEvent("message_sent", {
          project_key: PROJECT,
          from_agent: "coordinator",
          to_agents: ["worker-1", "worker-2"],
          subject: "race",
          body: "b",
          importance: "normal",
          ack_required: false,
          operation_id: "op-race",
        });
      await append(event());
      // Crash state: event persisted, projection lost
      await db.query("DELETE FROM message_recipients");
      await db.query("DELETE FROM messages WHERE operation_id = 'op-race'");
      // A concurrent projection (separate connection) wins between our read
      // and insert: it inserts the message but never gets to recipients.
      const other = await createLibSQLAdapter({ url: `file:${dbPath}` });
      const client = (db as unknown as { getClient(): { execute: (...a: unknown[]) => Promise<unknown> } }).getClient();
      const original = client.execute.bind(client);
      let fired = false;
      client.execute = async (...a: unknown[]) => {
        const stmt = a[0] as string | { sql: string; args?: unknown[] };
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        const args = typeof stmt === "string" ? (a[1] as unknown[]) : stmt.args;
        if (!fired && /insert into "?messages"?/i.test(sql) && JSON.stringify(args ?? []).includes("op-race")) {
          fired = true;
          await other.query(
            "INSERT INTO messages (project_key, from_agent, subject, body, created_at, operation_id) VALUES (?, 'coordinator', 'race', 'b', 1, 'op-race')",
            [PROJECT],
          );
        }
        return original(...a);
      };
      try {
        await append(event());
      } finally {
        client.execute = original;
        await other.close?.();
      }
      expect(fired).toBe(true);
      const msgs = await db.query<{ id: number }>("SELECT id FROM messages WHERE operation_id = 'op-race'");
      expect(msgs.rows).toHaveLength(1);
      const recipients = await db.query<{ agent_name: string }>(
        "SELECT agent_name FROM message_recipients WHERE message_id = ? ORDER BY agent_name",
        [msgs.rows[0]?.id],
      );
      expect(recipients.rows.map((r) => r.agent_name)).toEqual(["worker-1", "worker-2"]);
      const events = await db.query<{ n: number }>("SELECT COUNT(id) AS n FROM events WHERE type = 'message_sent'");
      expect(events.rows[0]?.n).toBe(1);
    });
  }
});
