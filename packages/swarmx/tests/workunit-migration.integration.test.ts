import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import { migrateLegacyLifecycle, LegacyMissionConflictError, type LegacyLifecycleStore } from "../src/workunit/migrate.js";
import { reserveWorkUnit } from "../src/workunit/store.js";
import {
  acquireBuildLock,
  createLegacyLifecycleStore,
  createMissionStateStore,
  createTombstoneGuardedStorage,
  legacyTombstoneKey,
  LegacyLifecycleTombstonedError,
  putAttempt,
  readMission,
  setAssignment,
  type MissionScanOptions,
  type MissionStorageLike,
} from "../src/state.js";

const P = "p";
const T0 = "2026-01-01T00:00:00.000Z";
const at = (minute: number): string => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

function memoryStorage(map = new Map<string, unknown>()): MissionStorageLike & { map: Map<string, unknown> } {
  return {
    map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
    async remove(key) {
      map.delete(key);
    },
    async scan(options: MissionScanOptions) {
      const entries = [...map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value: structuredClone(value) }));
      return { entries };
    },
  };
}

const enc = (parts: string[]): string => parts.map(encodeURIComponent).join(":");

function attempt(callID: string, cellID: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callID,
    missionID: "m1",
    sessionID: "s1",
    cellID,
    epicID: "e1",
    agent: "coder",
    status: "succeeded",
    ts: at(1),
    dispatchToken: `tok-${callID}`,
    workerSessionID: `w-${callID}`,
    ...extra,
  };
}

function completion(callID: string, cellID: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectID: P,
    parentSessionID: "s1",
    missionID: "m1",
    workerSessionID: `w-${callID}`,
    taskID: cellID,
    epicID: "e1",
    workerAgentID: "coder",
    workerAgentName: "coder",
    attemptCallID: callID,
    dispatchToken: `tok-${callID}`,
    projectPath: "/repo",
    summary: `summary ${cellID}`,
    startTime: 1,
    filesTouched: ["src/a.ts"],
    submittedAt: 2,
    ...extra,
  };
}

function receipt(callID: string, cellID: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectID: P,
    sessionID: "s1",
    missionID: "m1",
    projectPath: "/repo",
    epicID: "e1",
    taskID: cellID,
    assignedAgentID: "coder",
    assignedAgentName: "coder",
    attemptCallID: callID,
    dispatchToken: `tok-${callID}`,
    filesTouched: ["src/a.ts"],
    diffHash: `diff-${cellID}`,
    reviewedAt: 3,
    ...extra,
  };
}

function seedLegacy(): Map<string, unknown> {
  const map = new Map<string, unknown>();
  map.set(`mission:${P}:s1`, {
    missionID: "m1",
    projectID: P,
    sessionID: "s1",
    active: true,
    mode: "dev",
    budget: { maxSpawns: 100, maxIterations: 3 },
    counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
    retryCauses: [{ cellID: "c4", epicID: "e1", attempt: 1, ts: at(2), failureReason: "tests broke" }],
    consolidation: { epicID: "e1", cellID: "cons", status: "pending", createdAt: 5 },
    createdAt: T0,
    updatedAt: T0,
  });
  map.set(`mission:${P}:s2`, {
    projectID: P,
    sessionID: "s2",
    active: false,
    mode: "audit",
    budget: { maxSpawns: 4, maxIterations: 1, workerShare: 0.5 },
    counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
    createdAt: T0,
    updatedAt: T0,
  });
  const attempts: Record<string, unknown>[] = [
    attempt("a-live", "c1", { status: "pending" }),
    attempt("a-succ", "c2"),
    attempt("a-follow", "c3", { followup: true }),
    attempt("a-fail", "c4", { status: "failed", ts: at(1) }),
    attempt("a-retry", "c4", { status: "aborted", ts: at(3) }),
    attempt("a-revoked", "c5", { revokedAt: at(4) }),
    attempt("a-final", "c6", { revokedAt: at(5) }),
    attempt("a-cancel", "c7"),
    attempt("a-sub", "c8"),
    attempt("a-appr", "c9"),
    attempt("a-review", "c10"),
    attempt("a-miss", "c11", { workerSessionID: undefined, dispatchToken: undefined }),
    attempt("a-nomission", "c12", { missionID: undefined, status: "failed", ts: at(6) }),
    attempt("a-s2", "c20", { missionID: undefined, sessionID: "s2", ts: at(7) }),
    attempt("a-ghost", "c30", { missionID: undefined, sessionID: "ghost" }),
  ];
  for (const value of attempts) {
    map.set(`attempt:${P}:${String(value.callID)}`, JSON.parse(JSON.stringify(value)));
  }
  map.set(`assignment:${P}:c1`, { cellID: "c1", agent: "coder", updatedAt: at(1), sessionID: "s1" });
  map.set(`assignment:${P}:c99`, { cellID: "c99", agent: "coder", updatedAt: at(1) });
  map.set(`assignment:${P}:c98`, { cellID: "c98", agent: "coder", updatedAt: at(1), sessionID: "s1" });
  map.set(`${enc(["pending-completion:", P, "c6"])}`, completion("a-final", "c6", { finalized: true }));
  map.set(`${enc(["pending-completion:", P, "c7"])}`, completion("a-cancel", "c7", { canceled: true }));
  map.set(`${enc(["pending-completion:", P, "c8"])}`, completion("a-sub", "c8"));
  map.set(`${enc(["pending-completion:", P, "c9"])}`, completion("a-appr", "c9"));
  map.set(`${enc(["pending-completion:", P, "c10"])}`, completion("a-review", "c10"));
  map.set(
    `${enc(["review-receipt:", P, "s1", "m1", "c9"])}`,
    receipt("a-appr", "c9", { approval: { diffHash: "diff-c9", approvedAt: 4 } }),
  );
  map.set(`${enc(["review-receipt:", P, "s1", "m1", "c10"])}`, receipt("a-review", "c10"));
  map.set(`build-lock:${P}`, { projectID: P, sessionID: "s1", callID: "build-call", command: "bun test", acquiredAt: at(8) });
  map.set(`cleanup-claim:${P}`, { taskID: "c4", at: 1234 });
  return map;
}

async function setup(map = seedLegacy()) {
  const db: DatabaseAdapter = await createLibSQLAdapter({ url: ":memory:" });
  await ensureWorkUnitSchema(db);
  const storage = memoryStorage(map);
  const missions = createMissionStateStore(storage, { projectID: P });
  const legacyStore = createLegacyLifecycleStore(missions);
  return { db, storage, missions, legacyStore };
}

async function unit(db: DatabaseAdapter, callID: string): Promise<Record<string, unknown>> {
  const result = await db.query<Record<string, unknown>>("SELECT * FROM swarmx_work_units WHERE call_id = ?", [callID]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`missing unit ${callID}`);
  return row;
}

async function count(db: DatabaseAdapter, table: string): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT COUNT(1) AS n FROM ${table}`);
  return Number(result.rows[0]?.n ?? 0);
}

describe("legacy lifecycle import", () => {
  test("legacyImportIsIdempotent", async () => {
    const { db, legacyStore } = await setup();
    const first = await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const counts = [await count(db, "swarmx_missions"), await count(db, "swarmx_work_units"), await count(db, "swarmx_locks"), await count(db, "swarmx_legacy_assignments")];
    const second = await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(first.tombstoned).toBe(true);
    expect(first.imported).toBeGreaterThan(0);
    expect(second.imported).toBe(0);
    expect([await count(db, "swarmx_missions"), await count(db, "swarmx_work_units"), await count(db, "swarmx_locks"), await count(db, "swarmx_legacy_assignments")]).toEqual(counts);
    expect(counts).toEqual([2, 14, 2, 3]);
  });

  test("mission mapping preserves mode, budget policy and consolidation; inactive is FINISHED and ambiguous", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const rows = (await db.query<Record<string, unknown>>("SELECT * FROM swarmx_missions ORDER BY session_id")).rows;
    expect(rows[0]).toMatchObject({ session_id: "s1", mission_id: "m1", state: "OPEN", mode: "dev", budget_limit: 100, epic_id: "e1" });
    expect(JSON.parse(String(rows[0]?.budget_policy_json))).toEqual({
      total: 100,
      perCellIterations: 3,
      workerShare: { agent: "swarm-worker", maxFraction: 0.2 },
      version: 1,
    });
    expect(JSON.parse(String(rows[0]?.consolidation_json))).toEqual({ epicID: "e1", cellID: "cons", status: "pending", createdAt: 5 });
    expect(rows[1]).toMatchObject({ session_id: "s2", mission_id: `legacy:${T0}`, state: "FINISHED", mode: "audit" });
    expect(JSON.parse(String(rows[1]?.budget_policy_json)).workerShare.maxFraction).toBe(0.5);
    expect(JSON.parse(String(rows[1]?.legacy_source)).close_intent_ambiguous).toBe(true);
  });

  test("liveWorkerAttemptImportsBound", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-live")).toMatchObject({
      id: "unit:p:m1:a-live",
      state: "BOUND",
      worker_session: "w-a-live",
      worker_agent: "coder",
      dispatch_token: "tok-a-live",
      cell_id: "c1",
      idem_key: createHash("sha256").update("p|m1|c1|1").digest("hex"),
    });
  });

  test("succeededDispatchDoesNotBecomeDone", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-succ")).toMatchObject({ state: "BOUND", budget_charge: 1 });
    expect(await unit(db, "a-s2")).toMatchObject({ state: "BOUND", mission_pk: expect.stringContaining("s2") });
  });

  test("followupAttemptImportsZeroCharge", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-follow")).toMatchObject({ state: "DONE", budget_charge: 0 });
  });

  test("attempt status mapping: revoked, failed, aborted retry chain", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-revoked")).toMatchObject({ state: "REVOKED" });
    expect(await unit(db, "a-fail")).toMatchObject({ state: "FAILED", attempt_no: 1, retry_of: null });
    expect(await unit(db, "a-retry")).toMatchObject({
      state: "ABANDONED",
      attempt_no: 2,
      retry_of: "unit:p:m1:a-fail",
      idem_key: createHash("sha256").update("p|m1|c4|2").digest("hex"),
    });
    expect(await unit(db, "a-nomission")).toMatchObject({ state: "FAILED", mission_pk: expect.stringContaining("m1") });
  });

  test("finalizedCompletionImportsDone", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-final")).toMatchObject({ state: "DONE" });
  });

  test("canceledCompletionImportsCancelled", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-cancel")).toMatchObject({ state: "CANCELLED" });
  });

  test("approvedReceiptImportsApproved", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(await unit(db, "a-appr")).toMatchObject({ state: "APPROVED", diff_hash: "diff-c9", review_by: "coder" });
  });

  test("pendingCompletionAndReviewReceiptImportToCorrectStates", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const submitted = await unit(db, "a-sub");
    expect(submitted.state).toBe("SUBMITTED");
    expect(String(submitted.evidence_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(submitted.evidence_json)).summary).toBe("summary c8");
    const review = await unit(db, "a-review");
    expect(review).toMatchObject({ state: "IN_REVIEW", diff_hash: "diff-c10" });
    expect(JSON.parse(String(review.verification_receipt_json)).attemptCallID).toBe("a-review");
  });

  test("missingWorkerImportsAmbiguousBound", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const row = await unit(db, "a-miss");
    expect(row).toMatchObject({ state: "BOUND", worker_session: null, dispatch_token: null });
    expect(JSON.parse(String(row.legacy_source)).legacy_ambiguous).toBe(true);
  });

  test("assignmentWithoutAttemptDoesNotCreateUnit", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect((await db.query("SELECT id FROM swarmx_work_units WHERE cell_id IN ('c98', 'c99')")).rows).toEqual([]);
    const ledger = (await db.query<Record<string, unknown>>(
      "SELECT * FROM swarmx_legacy_assignments WHERE cell_id = 'c98'",
    )).rows[0];
    expect(ledger).toMatchObject({ owner: "s1", agent: "coder", mission_pk: expect.stringContaining("m1") });
    expect(JSON.parse(String(ledger?.raw_json)).legacy_ambiguous).toBe(true);
  });

  test("unownedAssignmentDoesNotBlock", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const ledger = (await db.query<Record<string, unknown>>("SELECT * FROM swarmx_legacy_assignments WHERE cell_id = 'c99'")).rows[0];
    expect(ledger).toMatchObject({ owner: null });
    const reserved = await reserveWorkUnit(db, {
      project: P,
      missionId: "m1",
      sessionId: "s1",
      workerAgent: "agent-1",
      callId: "new-call",
      dispatchToken: "new-tok",
      cellId: "c99",
      budgetCharge: 1,
      idemKey: "new-idem",
      attemptNo: 1,
    });
    expect(reserved.state).toBe("RESERVED");
  });

  test("retryCausesArePreserved", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const row = (await db.query<Record<string, unknown>>("SELECT retry_causes_json FROM swarmx_missions WHERE session_id = 's1'")).rows[0];
    expect(JSON.parse(String(row?.retry_causes_json))).toEqual([
      { cellID: "c4", epicID: "e1", attempt: 1, ts: at(2), failureReason: "tests broke" },
    ]);
  });

  test("buildAndCleanupLocksImportWithLegacyTokens", async () => {
    const { db, legacyStore } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const rows = (await db.query<Record<string, unknown>>("SELECT * FROM swarmx_locks ORDER BY name")).rows;
    expect(rows).toEqual([
      { name: "build:p", token: "legacy:build-call", owner_session: "s1", fence: 1, acquired_at: Date.parse(at(8)) },
      { name: "cleanup:p", token: "legacy:cleanup:c4:1234", owner_session: "legacy", fence: 1, acquired_at: 1234 },
    ]);
  });

  test("tombstone is written last, after every import row exists", async () => {
    const { db, legacyStore } = await setup();
    const calls: string[] = [];
    let unitsAtTombstone = -1;
    const spy: LegacyLifecycleStore = {
      listMissions: (p) => (calls.push("listMissions"), legacyStore.listMissions(p)),
      getMission: (p, s) => (calls.push("getMission"), legacyStore.getMission(p, s)),
      listAttempts: (p, s) => (calls.push("listAttempts"), legacyStore.listAttempts(p, s)),
      listAssignments: (p) => (calls.push("listAssignments"), legacyStore.listAssignments(p)),
      listPendingCompletions: (p) => (calls.push("listPendingCompletions"), legacyStore.listPendingCompletions(p)),
      listReviewReceipts: (p) => (calls.push("listReviewReceipts"), legacyStore.listReviewReceipts(p)),
      getBuildLock: (p) => (calls.push("getBuildLock"), legacyStore.getBuildLock(p)),
      getCleanupClaim: (p) => (calls.push("getCleanupClaim"), legacyStore.getCleanupClaim(p)),
      setTombstone: async (p, s, v) => {
        calls.push("setTombstone");
        unitsAtTombstone = await count(db, "swarmx_work_units");
        return legacyStore.setTombstone(p, s, v);
      },
    };
    await migrateLegacyLifecycle(db, { project: P, legacyStore: spy });
    expect(calls.at(-1)).toBe("setTombstone");
    expect(calls.filter((c) => c === "setTombstone")).toHaveLength(1);
    expect(unitsAtTombstone).toBe(14);
  });

  test("tombstone is not written when the import fails", async () => {
    const { db, legacyStore } = await setup();
    let tombstoned = false;
    const failing: LegacyLifecycleStore = {
      ...legacyStore,
      getCleanupClaim: async () => {
        throw new Error("kv down");
      },
      setTombstone: async () => {
        tombstoned = true;
      },
    };
    await expect(migrateLegacyLifecycle(db, { project: P, legacyStore: failing })).rejects.toThrow("kv down");
    expect(tombstoned).toBe(false);
  });

  test("tombstoneDisablesFutureKVWrites", async () => {
    const { db, legacyStore, missions, storage } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const before = JSON.stringify([...storage.map.entries()]);
    await expect(putAttempt(missions, P, attempt("late", "c50") as never)).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
    await expect(setAssignment(missions, P, "c50", "coder")).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
    const mission = await readMission(missions, P, "s1");
    await expect(missions.save({ ...mission!, active: false })).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
    await expect(acquireBuildLock(missions, P, "s1", "b2", "bun test")).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
    expect(JSON.stringify([...storage.map.entries()])).toBe(before);
  });

  test("legacyFallbackIsReadOnlyForOneRelease", async () => {
    const { db, legacyStore, missions } = await setup();
    const result = await migrateLegacyLifecycle(db, { project: P, legacyStore });
    expect(result.skipped).toBe(1);
    expect((await db.query("SELECT id FROM swarmx_work_units WHERE call_id = 'a-ghost'")).rows).toEqual([]);
    const ghost = (await legacyStore.listAttempts(P, "ghost")).map((a) => a.callID);
    expect(ghost).toEqual(["a-ghost"]);
    expect((await readMission(missions, P, "s1"))?.missionID).toBe("m1");
  });

  test("rollback to the pre-import KV snapshot restores writable legacy state and re-imports deterministically", async () => {
    const original = seedLegacy();
    const snapshot = structuredClone(original);
    const { db, legacyStore, missions, storage } = await setup(original);
    const first = await migrateLegacyLifecycle(db, { project: P, legacyStore });
    storage.map.clear();
    for (const [key, value] of snapshot) storage.map.set(key, value);
    await setAssignment(missions, P, "c51", "coder");
    expect(storage.map.has(`assignment:${P}:c51`)).toBe(true);
    storage.map.delete(`assignment:${P}:c51`);
    const fresh = await setup(structuredClone(snapshot));
    const again = await migrateLegacyLifecycle(fresh.db, { project: P, legacyStore: fresh.legacyStore });
    expect(again).toEqual(first);
    const ids = async (d: DatabaseAdapter) =>
      (await d.query<{ id: string; state: string }>("SELECT id, state FROM swarmx_work_units ORDER BY id")).rows;
    expect(await ids(fresh.db)).toEqual(await ids(db));
  });
});

describe("round-1 fixes", () => {
  test("standalone mission with no other records is imported", async () => {
    const map = seedLegacy();
    map.set(`mission:${P}:s3`, {
      missionID: "m3",
      projectID: P,
      sessionID: "s3",
      active: true,
      mode: "dev",
      budget: { maxSpawns: 2, maxIterations: 1 },
      counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
      createdAt: T0,
      updatedAt: T0,
    });
    map.set(`mission:other:s9`, { ...(map.get(`mission:${P}:s3`) as object), projectID: "other", sessionID: "s9" });
    const { db, legacyStore } = await setup(map);
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const rows = (await db.query<Record<string, unknown>>("SELECT session_id, mission_id, state FROM swarmx_missions ORDER BY session_id")).rows;
    expect(rows).toEqual([
      { session_id: "s1", mission_id: "m1", state: "OPEN" },
      { session_id: "s2", mission_id: `legacy:${T0}`, state: "FINISHED" },
      { session_id: "s3", mission_id: "m3", state: "OPEN" },
    ]);
  });

  test("live native mission on the same session aborts import without attempts or tombstone", async () => {
    const { db, legacyStore, storage } = await setup();
    await db.query(
      "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('native', 'p', 's1', 'native-m', 'OPEN', 1, 0, 0)",
    );
    await expect(migrateLegacyLifecycle(db, { project: P, legacyStore })).rejects.toBeInstanceOf(LegacyMissionConflictError);
    expect(await count(db, "swarmx_work_units")).toBe(0);
    expect(await count(db, "swarmx_missions")).toBe(1);
    expect([...storage.map.keys()].some((k) => k.startsWith("legacy-tombstone:"))).toBe(false);
  });

  test("guarded storage refuses set/remove on every lifecycle prefix after tombstone and keeps KV byte-identical", async () => {
    const { db, legacyStore, storage } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const guarded = createTombstoneGuardedStorage(storage);
    const keys = [
      `mission:${P}:s1`,
      `budget:${P}:s1`,
      `attempt:${P}:a-live`,
      `assignment:${P}:c1`,
      `build-lock:${P}`,
      `cleanup-claim:${P}`,
      enc(["pending-completion:", P, "c8"]),
      enc(["review-receipt:", P, "s1", "m1", "c9"]),
    ];
    const before = JSON.stringify([...storage.map.entries()]);
    for (const key of keys) {
      await expect(guarded.set(key, { x: 1 })).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
      await expect(guarded.remove(key)).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
      expect(JSON.stringify([...storage.map.entries()])).toBe(before);
    }
    expect(await guarded.get(`mission:${P}:s1`)).toBeDefined();
    await guarded.set(`mission:other:s1`, { y: 1 });
    expect(storage.map.has(`mission:other:s1`)).toBe(true);
  });

  test("per-session tombstone blocks only that session; project tombstone uses session *", async () => {
    const storage = memoryStorage();
    const guarded = createTombstoneGuardedStorage(storage);
    storage.map.set(legacyTombstoneKey(P, "s1"), { at: 1 });
    await expect(guarded.set(`mission:${P}:s1`, {})).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
    await guarded.set(`mission:${P}:s2`, {});
    expect(storage.map.has(`mission:${P}:s2`)).toBe(true);
    storage.map.set(legacyTombstoneKey(P, "*"), { at: 1 });
    await expect(guarded.set(`mission:${P}:s2`, {})).rejects.toBeInstanceOf(LegacyLifecycleTombstonedError);
  });

  test("tombstoned load with count drift returns the legacy projection without writing", async () => {
    const { db, legacyStore, storage } = await setup();
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const missions = createMissionStateStore(createTombstoneGuardedStorage(storage), { projectID: P });
    const before = JSON.stringify([...storage.map.entries()]);
    const loaded = await missions.load(P, "s1");
    expect(loaded?.counts.spawns).toBe(0);
    expect(JSON.stringify([...storage.map.entries()])).toBe(before);
  });

  test("assignment ledger lookup is mission-scoped", async () => {
    const map = seedLegacy();
    map.set(`assignment:${P}:c20`, { cellID: "c20", agent: "coder", updatedAt: at(1), sessionID: "s1" });
    const { db, legacyStore } = await setup(map);
    await migrateLegacyLifecycle(db, { project: P, legacyStore });
    const row = (await db.query<Record<string, unknown>>("SELECT state FROM swarmx_legacy_assignments WHERE cell_id = 'c20'")).rows[0];
    expect(row?.state).toBe("legacy_ambiguous");
  });
});

describe("schema upgrade", () => {
  test("missionAndAssignmentColumnsUpgradeIdempotently", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    await db.exec(`CREATE TABLE swarmx_missions (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, session_id TEXT NOT NULL, mission_id TEXT NOT NULL,
      state TEXT NOT NULL, close_intent TEXT, fence INTEGER NOT NULL DEFAULT 0, budget_limit REAL,
      legacy_source TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    await db.exec(`CREATE TABLE swarmx_legacy_assignments (
      project TEXT NOT NULL, cell_id TEXT NOT NULL, owner TEXT, raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (project, cell_id))`);
    await db.query("INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, created_at, updated_at) VALUES ('m', 'p', 's', 'mid', 'OPEN', 1, 1)");
    await db.query("INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, raw_json, created_at) VALUES ('p', 'c', NULL, '{}', 1)");
    await ensureWorkUnitSchema(db);
    await ensureWorkUnitSchema(db);
    const cols = async (table: string) =>
      (await db.query<{ name: string }>(`PRAGMA table_info(${table})`)).rows.map((r) => r.name);
    expect(await cols("swarmx_missions")).toEqual(
      expect.arrayContaining(["epic_id", "mode", "budget_policy_json", "consolidation_json", "retry_causes_json"]),
    );
    expect(await cols("swarmx_legacy_assignments")).toEqual(
      expect.arrayContaining(["mission_pk", "agent", "state", "updated_at"]),
    );
    expect((await db.query("SELECT id, mode FROM swarmx_missions")).rows).toEqual([{ id: "m", mode: null }]);
    expect((await db.query("SELECT cell_id, agent FROM swarmx_legacy_assignments")).rows).toEqual([{ cell_id: "c", agent: null }]);

    const fresh = await createLibSQLAdapter({ url: ":memory:" });
    await ensureWorkUnitSchema(fresh);
    await ensureWorkUnitSchema(fresh);
    expect(await (async () => (await fresh.query<{ name: string }>("PRAGMA table_info(swarmx_legacy_assignments)")).rows.map((r) => r.name))()).toEqual(
      expect.arrayContaining(["mission_pk", "agent", "state", "updated_at"]),
    );
  });
});
