import { afterEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import type { MissionCellSnapshot, RetryCauseRecord } from "../src/types.js";
import { selectReadyCells } from "../src/state.js";
import { ensureWorkUnitSchema, type Mission, type WorkUnit } from "../src/workunit/schema.js";
import type { AssignmentRow } from "../src/workunit/mission.js";
import { projectMission, projectMissionCells, selectMissionOrphanCandidates } from "../src/workunit/projection.js";

const policy = { total: 8, perCellIterations: 4, workerShare: { agent: "swarm-worker", maxFraction: 0.25 }, version: 1 as const };

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission:p:s:m1", project: "p", session_id: "s", mission_id: "m1", epic_id: "epic-1", state: "OPEN",
    close_intent: null, fence: 2, budget_limit: null, legacy_source: null, mode: "dev",
    budget_policy_json: JSON.stringify(policy), consolidation_json: null, retry_causes_json: null,
    created_at: 100, updated_at: 200, ...overrides,
  };
}

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: "unit-1", project: "p", mission_pk: "mission:p:s:m1", call_id: "call-1", cell_id: "cell-1", idem_key: "idem-1",
    attempt_no: 1, retry_of: null, state: "DONE", fence: 1, dispatch_token: null, worker_session: null,
    worker_agent: "swarm-worker", budget_charge: 1, evidence_hash: null, diff_hash: null, evidence_json: null,
    review_verdict: null, review_by: null, review_feedback_json: null, verification_receipt_json: null, completion_amendment_json: null, review_diff_hash: null,
    reason: null, error_json: null, legacy_source: null, created_at: 100, updated_at: 150, ...overrides,
  };
}

const assignment: AssignmentRow = {
  project: "p", cell_id: "cell-2", owner: "session-assigned", raw_json: "{}", created_at: 100,
  mission_pk: "mission:p:s:m1", agent: "assigned-agent", state: "assigned", updated_at: 150,
};

describe("WorkUnit mission projections", () => {
  let db: DatabaseAdapter | undefined;
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  test("projects budget and charged-work counters from the unit ledger", () => {
    const projected = projectMission({
      mission: mission(),
      units: [
        unit({ id: "u1", cell_id: "cell-1", budget_charge: 1 }),
        unit({ id: "u2", call_id: "call-2", cell_id: "cell-1", attempt_no: 2, budget_charge: 2, worker_agent: "specialist" }),
        unit({ id: "u3", call_id: "call-3", cell_id: "cell-2", budget_charge: 0, worker_agent: "swarm-worker" }),
        unit({ id: "u4", call_id: "call-4", cell_id: null, budget_charge: null, worker_agent: "swarm-worker" }),
      ],
      assignments: [assignment],
    });

    expect(projected.budget).toEqual({ maxSpawns: 8, maxIterations: 4, workerShare: 0.25 });
    expect(projected.counts).toEqual({ spawns: 4, cells: 1, attemptsByCell: { "cell-1": 2 }, workerSpawns: 3 });
    expect(projected).toMatchObject({ active: true, mode: "dev", projectID: "p", sessionID: "s", missionID: "m1" });
  });

  test("falls back to the legacy budget limit when policy workerShare is missing or invalid", () => {
    const invalidPolicies = [
      JSON.stringify({ total: 99, perCellIterations: 8, version: 1 }),
      JSON.stringify({ total: 99, perCellIterations: 8, workerShare: { agent: "worker", maxFraction: 2 }, version: 1 }),
    ];
    for (const budgetPolicy of invalidPolicies) {
      const projected = projectMission({
        mission: mission({ budget_limit: 7, budget_policy_json: budgetPolicy }),
        units: [],
        assignments: [],
      });
      expect(projected.budget).toEqual({ maxSpawns: 7, maxIterations: 0 });
    }
  });

  test("accepts a valid policy with null workerShare", () => {
    const projected = projectMission({
      mission: mission({ budget_policy_json: JSON.stringify({ total: 6, perCellIterations: 2, workerShare: null, version: 1 }) }),
      units: [],
      assignments: [],
    });
    expect(projected.budget).toEqual({ maxSpawns: 6, maxIterations: 2 });
  });

  test("omits malformed consolidation JSON instead of throwing", () => {
    const projected = projectMission({ mission: mission({ consolidation_json: "{" }), units: [], assignments: [] });
    expect(projected).not.toHaveProperty("consolidation");
  });

  test("ignores malformed retry-cause entries and retains valid causes", () => {
    const valid = { cellID: "valid-cell", epicID: "epic-1", attempt: 2, ts: "2026-02-01T00:00:00.000Z", failureReason: "known failure" };
    const projected = projectMission({
      mission: mission({ retry_causes_json: JSON.stringify([null, { cellID: "bad", epicID: "epic-1", attempt: "2", ts: 4 }, valid]) }),
      units: [],
      assignments: [],
    });
    expect(projected.retryCauses).toEqual([valid]);
  });

  test("excludes assignments owned by another mission in the same project", () => {
    const cells = projectMissionCells({
      mission: mission(),
      units: [],
      assignments: [{ ...assignment, cell_id: "foreign-cell", mission_pk: "mission:p:s:other" }],
      cells: [],
    });
    expect(cells).toEqual([]);
  });

  test("merges retry-unit reasons with stored causes and retains the newest twenty", () => {
    const old = Array.from({ length: 20 }, (_, index): RetryCauseRecord => ({
      cellID: `cell-${index}`, epicID: "epic-1", attempt: 1, ts: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, failureReason: `old-${index}`,
    }));
    const duplicate = { cellID: "cell-retry", epicID: "epic-1", attempt: 2, ts: "2026-02-01T00:00:00.000Z", failureReason: "stored wins" };
    const projected = projectMission({
      mission: mission({ retry_causes_json: JSON.stringify([...old, duplicate]) }),
      units: [
        unit({ id: "retry", cell_id: "cell-retry", attempt_no: 2, retry_of: "prior", reason: "unit reason", updated_at: Date.parse(duplicate.ts) }),
        unit({ id: "retry-new", call_id: "call-retry-new", idem_key: "idem-retry-new", cell_id: "cell-derived", attempt_no: 3, retry_of: "prior-2", reason: "derived reason", updated_at: Date.parse("2026-03-01T00:00:00.000Z") }),
      ],
      assignments: [],
    });
    expect(projected.retryCauses).toHaveLength(20);
    expect(projected.retryCauses?.[0]).toEqual(old[2]);
    expect(projected.retryCauses?.at(-2)).toEqual(duplicate);
    expect(projected.retryCauses?.find((cause) => cause.cellID === "cell-derived")).toEqual({
      cellID: "cell-derived", epicID: "epic-1", attempt: 3, ts: "2026-03-01T00:00:00.000Z", failureReason: "derived reason",
    });
  });

  test("projects cell status and agent with Hive, assignment, then latest-unit precedence", () => {
    const snapshots: MissionCellSnapshot[] = [
      { id: "cell-1", status: "open", agent: "hive-agent", attempts: 5, title: "Hive cell" },
      { id: "cell-2", status: "pending", attempts: 0 },
    ];
    const cells = projectMissionCells({
      mission: mission(),
      units: [
        unit({ id: "u-old", cell_id: "cell-1", state: "FAILED", worker_agent: "unit-agent", updated_at: 110 }),
        unit({ id: "u-new", call_id: "c-new", cell_id: "cell-1", attempt_no: 4, state: "DONE", worker_agent: "latest-agent", updated_at: 120 }),
        unit({ id: "u-2", cell_id: "cell-2", state: "FAILED", worker_agent: "unit-two", updated_at: 130 }),
        unit({ id: "u-3", cell_id: "cell-3", state: "BOUND", worker_agent: "unit-three", updated_at: 140 }),
        unit({ id: "u-4", call_id: "call-4", idem_key: "idem-4", cell_id: "cell-4", state: "REJECTED", updated_at: 150 }),
      ],
      assignments: [assignment],
      cells: snapshots,
    });
    expect(cells).toMatchObject([
      { id: "cell-1", status: "open", agent: "hive-agent", attempts: 5, title: "Hive cell" },
      { id: "cell-2", status: "pending", agent: "assigned-agent", attempts: 1 },
      { id: "cell-3", status: "in_progress", agent: "unit-three", attempts: 1 },
      { id: "cell-4", status: "failed", attempts: 1 },
    ]);
    expect(selectReadyCells(cells).map((cell) => cell.id)).toEqual(["cell-1", "cell-2"]);
  });

  test("selects only aged RESERVED and BOUND units in stable order without writing", async () => {
    db = await createLibSQLAdapter({ url: ":memory:" });
    await ensureWorkUnitSchema(db);
    const missionRow = mission();
    await db.query(
      `INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [missionRow.id, missionRow.project, missionRow.session_id, missionRow.mission_id, missionRow.state, missionRow.fence, missionRow.created_at, missionRow.updated_at],
    );
    const stored = [
      unit({ id: "b", call_id: "call-b", idem_key: "idem-b", cell_id: "cell-b", state: "BOUND", updated_at: 80 }),
      unit({ id: "a", call_id: "call-a", idem_key: "idem-a", cell_id: "cell-a", state: "RESERVED", updated_at: 80 }),
      unit({ id: "young", call_id: "call-young", idem_key: "idem-young", cell_id: "cell-young", state: "BOUND", updated_at: 91 }),
      unit({ id: "done", call_id: "call-done", idem_key: "idem-done", cell_id: "cell-done", state: "DONE", updated_at: 50 }),
    ];
    for (const candidate of stored) {
      await db.query(
        `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, worker_agent, budget_charge, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [candidate.id, candidate.project, candidate.mission_pk, candidate.call_id, candidate.cell_id, candidate.idem_key, candidate.attempt_no, candidate.state, candidate.fence, candidate.worker_agent, candidate.budget_charge, candidate.created_at, candidate.updated_at],
      );
    }
    const before = await db.query("SELECT id, state, fence, updated_at FROM swarmx_work_units ORDER BY id");
    const candidates = selectMissionOrphanCandidates({ units: stored, now: 100, orphanGraceMs: 10 });
    expect(candidates.map((candidate) => candidate.id)).toEqual(["a", "b"]);
    const after = await db.query("SELECT id, state, fence, updated_at FROM swarmx_work_units ORDER BY id");
    expect(after.rows).toEqual(before.rows);
  });
});
