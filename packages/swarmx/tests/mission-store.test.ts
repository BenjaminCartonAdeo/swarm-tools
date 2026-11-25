import { afterEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema, type Mission } from "../src/workunit/schema.js";
import {
  assignCell,
  createMission,
  getMission,
  listUnits,
  listMissions,
  MissionConflictError,
  recordRetryCause,
  releaseAssignment,
  setConsolidation,
  updateMissionPolicy,
} from "../src/workunit/mission.js";
import { getMissionByPk } from "../src/workunit/store.js";

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
    expect(await getMissionByPk(adapter, first.id)).toEqual(first);
    expect(await listMissions(adapter, "store-project", "store-session")).toEqual([first]);
    expect(await listMissions(adapter, "another-project")).toEqual([]);
    expect(await listMissions(adapter, "store-project")).toEqual([first]);
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
    const released = await releaseAssignment(adapter, { project: "p", cellId: "cell-1", now: 22 });
    expect(released).toMatchObject({ owner: null, agent: null, state: "released", updated_at: 22 });
    expect(await releaseAssignment(adapter, { project: "p", cellId: "missing" })).toBeNull();
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
