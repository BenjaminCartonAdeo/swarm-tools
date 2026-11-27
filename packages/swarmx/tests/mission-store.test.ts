import { afterEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema, type Mission } from "../src/workunit/schema.js";
import {
  AssignmentReleaseConflictError,
  assignCell,
  createMission,
  getMission,
  getMissionByPk as missionGetMissionByPk,
  listUnits,
  listMissions,
  MissionConflictError,
  recordRetryCause,
  releaseAssignment,
  setConsolidation,
  updateMissionPolicy,
} from "../src/workunit/mission.js";
import { getMissionByPk as storeGetMissionByPk } from "../src/workunit/store.js";
import {
  createWorkUnitMissionStore,
  DerivedFieldWriteError,
  MissionSaveValidationError,
} from "../src/workunit/mission-store-adapter.js";
import type { MissionCellSnapshot, MissionState } from "../src/types.js";

const policy = {
  total: 12,
  perCellIterations: 3,
  workerShare: { agent: "swarm-worker", maxFraction: 0.25 },
  version: 1 as const,
};

describe("WorkUnit mission store", () => {
  let db: DatabaseAdapter | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  async function database(): Promise<DatabaseAdapter> {
    db = await createLibSQLAdapter({ url: ":memory:" });
    await ensureWorkUnitSchema(db);
    return db;
  }

  test("creates, retrieves, and lists persisted missions by project and session", async () => {
    const adapter = await database();
    const first = await createMission(adapter, {
      project: "store-project",
      sessionId: "store-session",
      missionId: "generation-1",
      epicId: "epic-1",
      mode: "dev",
      budgetPolicy: policy,
      consolidation: { epicID: "epic-1", cellID: "consolidate-1", status: "pending", createdAt: 10 },
      retryCauses: [{ cellID: "cell-1", epicID: "epic-1", attempt: 1, ts: "2026-01-01T00:00:00.000Z", failureReason: "first failure" }],
      now: 100,
    });

    expect(first.id).toBe("mission:store-project:store-session:generation-1");
    expect(first).toMatchObject({
      mission_id: "generation-1",
      mode: "dev",
      budget_policy_json: JSON.stringify(policy),
      consolidation_json: JSON.stringify({ epicID: "epic-1", cellID: "consolidate-1", status: "pending", createdAt: 10 }),
      retry_causes_json: JSON.stringify([{ cellID: "cell-1", epicID: "epic-1", attempt: 1, ts: "2026-01-01T00:00:00.000Z", failureReason: "first failure" }]),
      fence: 0,
      created_at: 100,
      updated_at: 100,
    });
    expect(await getMission(adapter, "store-project", "store-session")).toEqual(first);
    expect(await missionGetMissionByPk(adapter, first.id)).toEqual(first);
    expect(await listMissions(adapter, "store-project", "store-session")).toEqual([first]);
    expect(await listMissions(adapter, "another-project")).toEqual([]);
    expect(await listMissions(adapter, "store-project")).toEqual([first]);
  });

  test("mission module reuses the store primary-key lookup export", () => {
    expect(missionGetMissionByPk).toBe(storeGetMissionByPk);
  });

  test("generates an RFC 4122 UUID mission id when one is not supplied", async () => {
    const adapter = await database();
    const created = await createMission(adapter, { project: "p", sessionId: "s", mode: "dev", budgetPolicy: policy });
    expect(created.mission_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(created.id).toBe(`mission:p:s:${created.mission_id}`);
  });

  test("fenced mission mutations persist values and reject stale fences", async () => {
    const adapter = await database();
    const mission = await createMission(adapter, {
      project: "p",
      sessionId: "s",
      mode: "audit",
      budgetPolicy: policy,
      now: 10,
    });

    const updated = await updateMissionPolicy(adapter, { missionPk: mission.id, expectedFence: 0, budgetPolicy: { ...policy, total: 20 }, now: 11 });
    expect(updated).toMatchObject({ fence: 1, updated_at: 11, budget_policy_json: JSON.stringify({ ...policy, total: 20 }) });
    await expect(updateMissionPolicy(adapter, { missionPk: mission.id, expectedFence: 0, budgetPolicy: policy, now: 12 })).rejects.toThrow();

    const consolidation = { epicID: "epic", cellID: "cell-consolidation", status: "ready" as const, createdAt: 13 };
    const consolidated = await setConsolidation(adapter, { missionPk: mission.id, expectedFence: 1, consolidation, now: 13 });
    expect(consolidated).toMatchObject({ fence: 2, updated_at: 13, consolidation_json: JSON.stringify(consolidation) });

    const cause = { cellID: "cell-a", epicID: "epic", attempt: 2, ts: "2026-02-01T00:00:00.000Z", failedCommand: "bun test" };
    const retried = await recordRetryCause(adapter, { missionPk: mission.id, expectedFence: 2, cause, now: 14 });
    expect(retried).toMatchObject({ fence: 3, updated_at: 14, retry_causes_json: JSON.stringify([cause]) });
  });

  test("validates budget policy and prevents a second live mission for the session", async () => {
    const adapter = await database();
    await expect(createMission(adapter, {
      project: "p", sessionId: "s", mode: "dev", budgetPolicy: { ...policy, total: Number.NaN },
    })).rejects.toThrow();
    await expect(createMission(adapter, {
      project: "p", sessionId: "s", mode: "dev", budgetPolicy: policy,
    })).resolves.toBeDefined();
    await expect(createMission(adapter, {
      project: "p", sessionId: "s", mode: "audit", budgetPolicy: policy,
    })).rejects.toBeInstanceOf(MissionConflictError);
  });

  test("session lookup prefers the live mission and falls back to the newest terminal mission", async () => {
    const adapter = await database();
    const terminal: Mission = {
      id: "old", project: "p", session_id: "s", mission_id: "old", epic_id: null, state: "FINISHED",
      close_intent: "finish", fence: 1, budget_limit: null, legacy_source: null,
      mode: "dev", budget_policy_json: JSON.stringify(policy), consolidation_json: null, retry_causes_json: null,
      created_at: 1, updated_at: 2,
    };
    await adapter.query(
      `INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, close_intent, fence, mode, budget_policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [terminal.id, terminal.project, terminal.session_id, terminal.mission_id, terminal.state, terminal.close_intent, terminal.fence, terminal.mode, terminal.budget_policy_json, terminal.created_at, terminal.updated_at],
    );
    const live = await createMission(adapter, { project: "p", sessionId: "s", mode: "dev", budgetPolicy: policy });
    expect(await getMission(adapter, "p", "s")).toEqual(live);
  });

  test("upserts assignment ownership and releases without leaving a blocking owner", async () => {
    const adapter = await database();
    const mission = await createMission(adapter, { project: "p", sessionId: "s", mode: "dev", budgetPolicy: policy });
    const initial = await assignCell(adapter, { project: "p", cellId: "cell-1", missionPk: mission.id, agent: "worker-a", ownerSessionId: "session-a", now: 20 });
    expect(initial).toMatchObject({
      project: "p", cell_id: "cell-1", mission_pk: mission.id, agent: "worker-a", owner: "session-a", state: "assigned", updated_at: 20,
    });
    const changed = await assignCell(adapter, { project: "p", cellId: "cell-1", missionPk: mission.id, agent: "worker-b", ownerSessionId: "session-b", now: 21 });
    expect(changed).toMatchObject({ owner: "session-b", agent: "worker-b", state: "assigned", updated_at: 21 });
    const fenced = { project: "p", cellId: "cell-1", missionPk: mission.id, ownerSessionId: "s" };
    await expect(releaseAssignment(adapter, { ...fenced, ownerSessionId: "intruder" })).rejects.toThrow(AssignmentReleaseConflictError);
    await expect(releaseAssignment(adapter, { ...fenced, missionPk: "mission:other" })).rejects.toThrow(AssignmentReleaseConflictError);
    const released = await releaseAssignment(adapter, { ...fenced, now: 22 });
    expect(released).toMatchObject({ owner: null, agent: null, state: "released", updated_at: 22 });
    await expect(releaseAssignment(adapter, { ...fenced, cellId: "missing" })).rejects.toThrow(AssignmentReleaseConflictError);
  });

  test("lists mission units in stable creation order", async () => {
    const adapter = await database();
    const mission = await createMission(adapter, { project: "p", sessionId: "s", mode: "dev", budgetPolicy: policy });
    for (const [id, createdAt] of [["unit-later", 20], ["unit-first", 10]] as const) {
      await adapter.query(
        `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at)
         VALUES (?, 'p', ?, ?, ?, 1, 'DONE', 1, ?, ?)`,
        [id, mission.id, `call-${id}`, `idem-${id}`, createdAt, createdAt],
      );
    }
    expect((await listUnits(adapter, mission.id)).map((unit) => unit.id)).toEqual(["unit-first", "unit-later"]);
  });
});

describe("WorkUnit mission store adapter", () => {
  const opened: DatabaseAdapter[] = [];
  afterEach(async () => {
    for (const adapter of opened.splice(0)) await adapter.close?.();
  });
  async function fresh(): Promise<DatabaseAdapter> {
    const adapter = await createLibSQLAdapter({ url: ":memory:" });
    opened.push(adapter);
    await ensureWorkUnitSchema(adapter);
    return adapter;
  }
  const T0 = "2026-01-01T00:00:00.000Z";
  const base = (over: Partial<MissionState> = {}): MissionState => ({
    missionID: "m1", projectID: "p", sessionID: "s", active: true, mode: "dev",
    budget: { maxSpawns: 10, maxIterations: 2 },
    counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
    createdAt: T0, updatedAt: T0, ...over,
  });
  function legacyReader(missions: MissionState[]) {
    const reads: string[] = [];
    return {
      reads,
      getMission: async (project: string, session: string) => {
        reads.push(`get:${project}:${session}`);
        return missions.filter((m) => m.projectID === project && m.sessionID === session).at(-1);
      },
      listMissions: async (project: string) => {
        reads.push(`list:${project}`);
        return missions.filter((m) => m.projectID === project);
      },
    };
  }

  test("WorkUnit adapter save creates a native mission with policy v1 and load projects it", async () => {
    const adapter = await fresh();
    const store = createWorkUnitMissionStore(adapter);
    await store.save(base());
    const row = await getMission(adapter, "p", "s");
    expect(row).toMatchObject({ mission_id: "m1", state: "OPEN", fence: 0, created_at: Date.parse(T0), updated_at: Date.parse(T0) });
    expect(JSON.parse(row?.budget_policy_json ?? "null")).toEqual({
      total: 10, perCellIterations: 2, workerShare: { agent: "swarm-worker", maxFraction: 0.2 }, version: 1,
    });
    expect(await store.load("p", "s")).toEqual({
      missionID: "m1", projectID: "p", sessionID: "s", active: true, mode: "dev",
      budget: { maxSpawns: 10, maxIterations: 2, workerShare: 0.2 },
      counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
      retryCauses: [], createdAt: T0, updatedAt: T0,
    });
  });

  test("WorkUnit adapter load prefers native state and falls back to the read-only legacy view", async () => {
    const adapter = await fresh();
    const legacy = legacyReader([
      base({ missionID: "legacy-s", counts: { spawns: 4, cells: 1, attemptsByCell: { a: 4 }, workerSpawns: 0 } }),
      base({ missionID: "legacy-s2", sessionID: "s2" }),
    ]);
    const store = createWorkUnitMissionStore(adapter, { projectID: "p", legacyReader: legacy });
    await store.save(base());
    expect((await store.load("p", "s"))?.missionID).toBe("m1");
    expect((await store.load("p", "s2"))?.missionID).toBe("legacy-s2");
    expect(await store.load("p", "none")).toBeUndefined();
    expect(await listMissions(adapter, "p", "s2")).toEqual([]);
  });

  test("WorkUnit adapter load cells projects injected Hive cells with units and assignments", async () => {
    const adapter = await fresh();
    const cells: MissionCellSnapshot[] = [{ id: "c1", title: "Cell one", attempts: 0 }];
    const store = createWorkUnitMissionStore(adapter, { listCells: async () => cells });
    await store.save(base());
    const mission = await getMission(adapter, "p", "s");
    await assignCell(adapter, { project: "p", cellId: "c2", missionPk: mission?.id ?? "", agent: "coder", ownerSessionId: "s" });
    expect(await store.loadCells("p", "s")).toEqual([
      { id: "c1", title: "Cell one", attempts: 0 },
      { id: "c2", agent: "coder", attempts: 0 },
    ]);
  });

  test("WorkUnit adapter list returns one current generation per session, native wins, sorted by createdAt then key", async () => {
    const adapter = await fresh();
    const legacy = legacyReader([
      base({ missionID: "legacy-old-s", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }),
      base({ missionID: "legacy-s2", sessionID: "s2", createdAt: "2025-06-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z" }),
      base({ missionID: "legacy-s3", sessionID: "s3", createdAt: T0, updatedAt: T0 }),
    ]);
    const store = createWorkUnitMissionStore(adapter, { projectID: "p", legacyReader: legacy });
    await store.save(base({ missionID: "old" }));
    await adapter.query("UPDATE swarmx_missions SET state = 'FINISHED' WHERE mission_id = 'old'");
    await store.save(base({ missionID: "new", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" }));
    await store.save(base({ missionID: "a-native", sessionID: "s4" }));
    const listed = await store.list();
    expect(listed.map((m) => `${m.sessionID}:${m.missionID}`)).toEqual([
      "s2:legacy-s2", "s4:a-native", "s3:legacy-s3", "s:new",
    ]);
  });

  test("WorkUnit adapter list without legacy reader only lists native sessions", async () => {
    const adapter = await fresh();
    const store = createWorkUnitMissionStore(adapter);
    await store.save(base());
    await store.save(base({ projectID: "q", missionID: "q1" }));
    expect((await store.list()).map((m) => `${m.projectID}:${m.missionID}`)).toEqual(["p:m1", "q:q1"]);
  });

  test("WorkUnit adapter save rejects invalid creation inputs and nonzero legacy counts", async () => {
    const adapter = await fresh();
    const store = createWorkUnitMissionStore(adapter);
    const bad: MissionState[] = [
      base({ missionID: "" }),
      base({ missionID: undefined }),
      base({ projectID: "" }),
      base({ sessionID: "" }),
      base({ active: false }),
      base({ counts: { spawns: 1, cells: 0, attemptsByCell: {}, workerSpawns: 0 } }),
      base({ counts: { spawns: 0, cells: 1, attemptsByCell: {}, workerSpawns: 0 } }),
      base({ counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 1 } }),
      base({ counts: { spawns: 0, cells: 0, attemptsByCell: { c: 1 }, workerSpawns: 0 } }),
      base({ updatedAt: "2026-01-02T00:00:00.000Z" }),
      base({ createdAt: "not-a-date", updatedAt: "not-a-date" }),
    ];
    for (const state of bad) {
      await expect(store.save(state)).rejects.toThrow(MissionSaveValidationError);
    }
    expect(await listMissions(adapter, "p")).toEqual([]);
  });

  test("WorkUnit adapter save updates writable fields, chaining fences across mutations", async () => {
    const adapter = await fresh();
    let tick = Date.parse(T0);
    const store = createWorkUnitMissionStore(adapter, { now: () => ++tick });
    await store.save(base());
    const loaded = await store.load("p", "s");
    if (loaded === undefined) throw new Error("missing");
    const consolidation = { epicID: "e", cellID: "c", status: "pending" as const, createdAt: 5 };
    await store.save({ ...loaded, mode: "audit", budget: { maxSpawns: 20, maxIterations: 3, workerShare: 0.5 }, consolidation });
    const row = await getMission(adapter, "p", "s");
    expect(row?.fence).toBe(3);
    const after = await store.load("p", "s");
    expect(after).toMatchObject({ mode: "audit", budget: { maxSpawns: 20, maxIterations: 3, workerShare: 0.5 }, consolidation });
    if (after === undefined) throw new Error("missing");
    await store.save(after);
    expect((await getMission(adapter, "p", "s"))?.fence).toBe(3);
  });

  test("WorkUnit adapter save throws DerivedFieldWriteError on derived drift and rejects identity changes", async () => {
    const adapter = await fresh();
    const store = createWorkUnitMissionStore(adapter);
    await store.save(base());
    const loaded = await store.load("p", "s");
    if (loaded === undefined) throw new Error("missing");
    for (const drift of [
      { ...loaded, active: false },
      { ...loaded, counts: { ...loaded.counts, spawns: 1 } },
      { ...loaded, counts: { ...loaded.counts, attemptsByCell: { c: 1 } } },
      { ...loaded, retryCauses: [{ cellID: "c", epicID: "e", attempt: 2, ts: T0 }] },
      { ...loaded, updatedAt: "2026-03-01T00:00:00.000Z" },
    ]) {
      await expect(store.save(drift)).rejects.toThrow(DerivedFieldWriteError);
    }
    await expect(store.save({ ...loaded, createdAt: "2025-03-01T00:00:00.000Z" })).rejects.toThrow(MissionSaveValidationError);
    expect((await getMission(adapter, "p", "s"))?.fence).toBe(0);
  });
});

describe("MissionStore core contract", () => {
  test("WorkUnit adapter and legacy store both satisfy the core MissionStore without KV members", async () => {
    const { createMissionStateStore } = await import("../src/state.js");
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      const native: import("../src/state.js").MissionStore = createWorkUnitMissionStore(db);
      expect(typeof native.load).toBe("function");
      expect(typeof native.save).toBe("function");
      expect(typeof native.list).toBe("function");
      expect("storage" in native).toBe(false);
      expect("listAgents" in native).toBe(false);
      const legacy: import("../src/state.js").MissionStore = createMissionStateStore({
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [],
      } as never);
      expect("storage" in legacy).toBe(true);
      const runtime: import("../src/types.js").SwarmxRuntime = {
        runTool: async () => undefined,
        store: native,
        now: () => 1,
        orphanGraceMs: 0,
      };
      expect(runtime.now?.()).toBe(1);
    } finally {
      await db.close?.();
    }
  });

  test("tests use the canonical SWARM_DB_PATH in-memory override", async () => {
    const { getDatabasePath } = await import("swarm-mail");
    expect(process.env.SWARM_DB_PATH).toBe(":memory:");
    expect(getDatabasePath()).toBe(":memory:");
    expect(process.env.SWARMX_WORKUNIT_DB).toBeUndefined();
  });
});
