import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import {
  bindWorkUnit,
  BudgetExceededError,
  BudgetGateError,
  BudgetPolicyError,
  AssignmentMismatchError,
  CallSettledError,
  CellBusyError,
  FenceConflictError,
  getMissionBudgetUsed,
  getWorkUnit,
  IdempotencyConflictError,
  InvalidPatchError,
  MissionClosedError,
  MissionOwnerMismatchError,
  recordLegacyAssignment,
  ReservationConflictError,
  reserveWorkUnit,
  retryWorkUnit,
  RetryNotAllowedError,
  transitionWorkUnit,
  beginMissionClose,
  cascadeMissionClose,
  finishMissionClose,
  MissionFenceConflictError,
  MissionNotDrainedError,
} from "../src/workunit/store.js";
import { LEGAL_WORK_UNIT_TRANSITIONS, type WorkUnitState } from "../src/workunit/schema.js";

async function seedUnit(
  db: DatabaseAdapter,
  id: string,
  state: WorkUnitState,
  fence = 1,
  budgetCharge: number | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m-${id}', 'p', 's-${id}', 'mission-${id}', 'OPEN', 1, 0, 0)`,
  );
  await db.query(
    `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, budget_charge, created_at, updated_at) VALUES ('${id}', 'p', 'm-${id}', 'call-${id}', 'idem-${id}', 1, '${state}', ${fence}, ${budgetCharge === null ? "NULL" : budgetCharge}, 0, 0)`,
  );
}

async function seedMission(
  db: DatabaseAdapter,
  { project = "p", missionId = "mission", sessionId = "session", state = "OPEN", budgetLimit = 10 }:
    { project?: string; missionId?: string; sessionId?: string; state?: string; budgetLimit?: number } = {},
): Promise<string> {
  const id = `mission-pk-${missionId}`;
  await db.query(
    "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, budget_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0)",
    [id, project, sessionId, missionId, state, budgetLimit],
  );
  return id;
}

function reservation(project = "p", overrides: Partial<Parameters<typeof reserveWorkUnit>[1]> = {}) {
  return {
    project,
    missionId: "mission",
    sessionId: "session",
    workerAgent: "agent-1",
    callId: "call-1",
    dispatchToken: "dispatch-1",
    cellId: "cell-1",
    budgetCharge: 2,
    idemKey: "idem-1",
    attemptNo: 1,
    ...overrides,
  };
}

async function setBudgetPolicy(
  db: DatabaseAdapter,
  policy: unknown,
  missionPk = "mission-pk-mission",
): Promise<void> {
  await db.query("UPDATE swarmx_missions SET budget_policy_json = ? WHERE id = ?", [JSON.stringify(policy), missionPk]);
}

async function setAssignment(
  db: DatabaseAdapter,
  cellId: string,
  { state, owner, agent }: { state: string | null; owner: string | null; agent: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, agent, state, raw_json, created_at)
     VALUES ('p', ?, ?, ?, ?, '{}', 0)`,
    [cellId, owner, agent, state],
  );
}

async function withWorkUnitDb(run: (db: DatabaseAdapter) => Promise<void>): Promise<void> {
  const db = await createLibSQLAdapter({ url: ":memory:" });
  try {
    await ensureWorkUnitSchema(db);
    await run(db);
  } finally {
    await db.close?.();
  }
}

function rowValue(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null || !(key in row)) {
    return undefined;
  }
  return Reflect.get(row, key);
}

describe("WorkUnit schema", () => {
  test("ensureWorkUnitSchemaAddsNullableEpicIdToLegacyMissionsIdempotently", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });

    try {
      await db.exec(`CREATE TABLE swarmx_missions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSING', 'FINISHED', 'CANCELLED', 'ABANDONED')),
        close_intent TEXT CHECK (close_intent IS NULL OR close_intent IN ('finish', 'cancel', 'abandon')),
        fence INTEGER NOT NULL DEFAULT 0,
        budget_limit REAL,
        legacy_source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project, session_id, mission_id)
      )`);
      await db.query(
        "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, budget_limit, created_at, updated_at) VALUES ('legacy-mission', 'p', 'legacy-session', 'legacy-id', 'FINISHED', 2, 4.5, 10, 11)",
      );

      await ensureWorkUnitSchema(db);
      await ensureWorkUnitSchema(db);

      const columns = await db.query("PRAGMA table_info(swarmx_missions)");
      expect(columns.rows.filter((row) => rowValue(row, "name") === "epic_id")).toHaveLength(1);
      expect(columns.rows.find((row) => rowValue(row, "name") === "epic_id")).toMatchObject({
        name: "epic_id",
        notnull: 0,
      });
      const legacyMission = await db.query("SELECT id, mission_id, epic_id, budget_limit FROM swarmx_missions");
      expect(legacyMission.rows).toEqual([
        { id: "legacy-mission", mission_id: "legacy-id", epic_id: null, budget_limit: 4.5 },
      ]);
    } finally {
      await db.close?.();
    }
  });

  test("schemaCreatesFiveTablesAndRequiredIndexes", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });

    try {
      await ensureWorkUnitSchema(db);
      await ensureWorkUnitSchema(db);

      const missions = await db.query("PRAGMA table_info(swarmx_missions)");
      expect(missions.rows.find((row) => rowValue(row, "name") === "epic_id")).toMatchObject({
        name: "epic_id",
        notnull: 0,
      });

      const tables = await db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'swarmx_%' ORDER BY name",
      );
      expect(tables.rows.map((row) => rowValue(row, "name"))).toEqual([
        "swarmx_effects",
        "swarmx_legacy_assignments",
        "swarmx_locks",
        "swarmx_missions",
        "swarmx_work_units",
      ]);

      const indexes = await db.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'swarmx_%' ORDER BY name",
      );
      expect(indexes.rows.map((row) => rowValue(row, "name"))).toEqual([
        "swarmx_effects_unit_kind_uq",
        "swarmx_missions_live_session_uq",
        "swarmx_units_live_cell_uq",
      ]);

      await db.query(
        "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m1', 'p', 's', 'x', 'OPEN', 1, 0, 0)",
      );
      await expect(
        db.query(
          "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m2', 'p', 's', 'y', 'CLOSING', 1, 0, 0)",
        ),
      ).rejects.toThrow();
      await db.query(
        "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m3', 'p', 's', 'z', 'FINISHED', 1, 0, 0)",
      );
      await expect(
        db.query(
          "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m4', 'p', 's', 'x', 'FINISHED', 1, 0, 0)",
        ),
      ).rejects.toThrow();

      await db.query(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u1', 'p', 'm1', 'call1', 'idem1', 1, 'RESERVED', 1, 0, 0)",
      );
      for (const [id, callId, idemKey] of [
        ["u2", "call1", "idem2"],
        ["u3", "call3", "idem1"],
      ]) {
        await expect(
          db.query(
            `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('${id}', 'p', 'm1', '${callId}', '${idemKey}', 1, 'BOUND', 1, 0, 0)`,
          ),
        ).rejects.toThrow();
      }
      await db.query(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u4', 'p', 'm1', 'call4', 'cell1', 'idem4', 1, 'RESERVED', 1, 0, 0)",
      );
      await expect(
        db.query(
          "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u5', 'p', 'm1', 'call5', 'cell1', 'idem5', 1, 'SUBMITTED', 1, 0, 0)",
        ),
      ).rejects.toThrow();
      await db.query("UPDATE swarmx_work_units SET state = 'DONE' WHERE id = 'u4'");
      await db.query(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u6', 'p', 'm1', 'call6', 'cell1', 'idem6', 1, 'RESERVED', 1, 0, 0)",
      );

      await db.query(
        "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('e1', 'u1', 'backend_complete', 1, 1, 'pending', 0, 0)",
      );
      await expect(
        db.query(
          "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('e2', 'u1', 'backend_complete', 1, 1, 'pending', 0, 0)",
        ),
      ).rejects.toThrow();
      const effectId = await db.query("PRAGMA table_info(swarmx_effects)");
      expect(
        effectId.rows.find((row) => rowValue(row, "name") === "effect_id")
          ? rowValue(effectId.rows.find((row) => rowValue(row, "name") === "effect_id"), "pk")
          : undefined,
      ).toBe(1);

      await db.query(
        "INSERT INTO swarmx_locks (name, token, owner_session, fence, acquired_at) VALUES ('global', 't1', 's1', 1, 0)",
      );
      await expect(
        db.query(
          "INSERT INTO swarmx_locks (name, token, owner_session, fence, acquired_at) VALUES ('global', 't2', 's2', 2, 0)",
        ),
      ).rejects.toThrow();

      await db.query(
        "INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, raw_json, created_at) VALUES ('p', 'legacy-cell', NULL, '{}', 0)",
      );
      await expect(
        db.query(
          "INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, raw_json, created_at) VALUES ('p', 'legacy-cell', 'worker', '{}', 0)",
        ),
      ).rejects.toThrow();
      const legacy = await db.query("PRAGMA table_info(swarmx_legacy_assignments)");
      expect(
        legacy.rows.find((row) => rowValue(row, "name") === "owner")
          ? rowValue(legacy.rows.find((row) => rowValue(row, "name") === "owner"), "notnull")
          : undefined,
      ).toBe(0);
    } finally {
      await db.close?.();
    }
  });
});

describe("WorkUnit transitions and budgets", () => {
  test("transitionUsesExpectedStateAndFence", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await seedUnit(db, "u1", "RESERVED", 4);

      const bound = await transitionWorkUnit(db, {
        unitId: "u1",
        expectedState: "RESERVED",
        unitFence: 4,
        nextState: "BOUND",
        patch: { kind: "bind", workerSession: "worker-session", workerAgent: "worker-agent" },
      });
      expect(bound.state).toBe("BOUND");
      expect(bound.fence).toBe(5);
      expect(bound.worker_session).toBe("worker-session");
      expect(bound.worker_agent).toBe("worker-agent");

      const submitted = await transitionWorkUnit(db, {
        unitId: "u1",
        expectedState: "BOUND",
        unitFence: 5,
        nextState: "SUBMITTED",
        patch: { kind: "submit", evidenceHash: "e-hash", diffHash: "d-hash", evidenceJson: '{"ok":true}' },
      });
      expect(submitted.fence).toBe(6);
      expect(submitted.evidence_hash).toBe("e-hash");
      expect(submitted.diff_hash).toBe("d-hash");
      expect(submitted.evidence_json).toBe('{"ok":true}');
    } finally {
      await db.close?.();
    }
  });

  test("staleFenceCannotOverwriteNewState", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await seedUnit(db, "u1", "RESERVED", 1);
      await transitionWorkUnit(db, {
        unitId: "u1",
        expectedState: "RESERVED",
        unitFence: 1,
        nextState: "BOUND",
        patch: { kind: "bind", workerSession: "w", workerAgent: "a" },
      });
      await expect(
        transitionWorkUnit(db, {
          unitId: "u1",
          expectedState: "RESERVED",
          unitFence: 1,
          nextState: "BOUND",
          patch: { kind: "bind", workerSession: "stale", workerAgent: "stale" },
        }),
      ).rejects.toMatchObject({ name: "FenceConflictError" });
      const current = await db.query("SELECT state, fence, worker_session FROM swarmx_work_units WHERE id = 'u1'");
      expect(current.rows[0]).toMatchObject({ state: "BOUND", fence: 2, worker_session: "w" });
    } finally {
      await db.close?.();
    }
  });

  test("budgetSumsChargesIncludingRetries", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await seedUnit(db, "u1", "FAILED", 2, 1.25);
      await db.query(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, retry_of, state, fence, budget_charge, created_at, updated_at) VALUES ('u2', 'p', 'm-u1', 'call-u2', 'idem-u2', 2, 'u1', 'DONE', 3, 2.5, 0, 0)",
      );
      expect(await getMissionBudgetUsed(db, "m-u1")).toBe(3.75);
    } finally {
      await db.close?.();
    }
  });

  test("everyIllegalTransitionIsRejectedWithoutWrite", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      const states = Object.keys(LEGAL_WORK_UNIT_TRANSITIONS) as WorkUnitState[];
      let counter = 0;
      for (const from of states) {
        for (const to of states) {
          if ((LEGAL_WORK_UNIT_TRANSITIONS[from] as readonly WorkUnitState[]).includes(to)) continue;
          const id = `illegal-${counter++}`;
          await seedUnit(db, id, from);
          const before = await db.query(`SELECT fence, state FROM swarmx_work_units WHERE id = '${id}'`);
          await expect(
            transitionWorkUnit(db, {
              unitId: id,
              expectedState: from,
              unitFence: 1,
              nextState: to,
              patch: undefined,
            }),
          ).rejects.toMatchObject({ name: "IllegalTransitionError" });
          const after = await db.query(`SELECT fence, state FROM swarmx_work_units WHERE id = '${id}'`);
          expect(after.rows).toEqual(before.rows);
        }
      }
    } finally {
      await db.close?.();
    }
  });

  test("requestChangesClearsWorkerSessionInSameUpdate", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await seedUnit(db, "rc", "IN_REVIEW", 7);
      await db.query("UPDATE swarmx_work_units SET worker_session = 'ws', worker_agent = 'wa' WHERE id = 'rc'");
      const returned = await transitionWorkUnit(db, {
        unitId: "rc",
        expectedState: "IN_REVIEW",
        unitFence: 7,
        nextState: "RETURNING",
        patch: { kind: "request_changes", reviewVerdict: "changes", reviewFeedbackJson: '{"fix":1}' },
      });
      expect(returned).toMatchObject({
        state: "RETURNING",
        fence: 8,
        worker_session: null,
        review_verdict: "changes",
        review_feedback_json: '{"fix":1}',
      });
      const stored = await db.query("SELECT state, fence, worker_session FROM swarmx_work_units WHERE id = 'rc'");
      expect(stored.rows[0]).toMatchObject({ state: "RETURNING", fence: 8, worker_session: null });
    } finally {
      await db.close?.();
    }
  });

  test("legalTransitionWithMissingOrWrongPatchPerformsNoWrite", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await seedUnit(db, "p1", "RESERVED", 3);
      const snapshot = async () =>
        (await db.query("SELECT state, fence, worker_session, updated_at FROM swarmx_work_units WHERE id = 'p1'")).rows[0];
      const before = await snapshot();
      await expect(
        transitionWorkUnit(db, { unitId: "p1", expectedState: "RESERVED", unitFence: 3, nextState: "BOUND" }),
      ).rejects.toBeInstanceOf(InvalidPatchError);
      await expect(
        transitionWorkUnit(db, {
          unitId: "p1",
          expectedState: "RESERVED",
          unitFence: 3,
          nextState: "BOUND",
          patch: { kind: "cancel", reason: "wrong" },
        }),
      ).rejects.toMatchObject({ name: "InvalidPatchError", expectedKind: "bind", actualKind: "cancel" });
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.close?.();
    }
  });

  test("concurrentSameFenceTransitionsHaveExactlyOneWinner", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await seedUnit(db, "race", "RESERVED", 1);
      const attempt = (session: string) =>
        transitionWorkUnit(db, {
          unitId: "race",
          expectedState: "RESERVED",
          unitFence: 1,
          nextState: "BOUND",
          patch: { kind: "bind", workerSession: session, workerAgent: session },
        });
      const results = await Promise.allSettled([attempt("a"), attempt("b")]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toBeInstanceOf(FenceConflictError);
      const stored = await db.query("SELECT fence FROM swarmx_work_units WHERE id = 'race'");
      expect(stored.rows[0]).toMatchObject({ fence: 2 });
    } finally {
      await db.close?.();
    }
  });
});

describe("WorkUnit reservation, retry, and legacy assignment", () => {
  test("reserveBlockedWhileMissionClosing", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db, { state: "CLOSING" });
      await expect(reserveWorkUnit(db, reservation())).rejects.toBeInstanceOf(MissionClosedError);
      expect((await db.query("SELECT id FROM swarmx_work_units")).rows).toHaveLength(0);
    });
  });

  test("reserveRejectsForeignMissionOwner", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await expect(reserveWorkUnit(db, reservation("p", { sessionId: "other-session" })))
        .rejects.toBeInstanceOf(MissionOwnerMismatchError);
    });
  });

  test("reserveIsIdempotentForSameCallIdBeforeSettlement", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const input = reservation();
      const first = await reserveWorkUnit(db, input);
      const replay = await reserveWorkUnit(db, input);
      expect(first.id).toBe("unit:p:mission:call-1");
      expect(replay).toEqual(first);
      expect(first.dispatch_token).toBe("dispatch-1");
      expect(first.state).toBe("RESERVED");
      expect(first.fence).toBe(1);
      expect((await db.query("SELECT id FROM swarmx_work_units")).rows).toHaveLength(1);
    });
  });

  test("reserveRejectsSameCallIdWithChangedPayload", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await reserveWorkUnit(db, reservation());
      await expect(reserveWorkUnit(db, reservation("p", { dispatchToken: "changed" })))
        .rejects.toBeInstanceOf(ReservationConflictError);
    });
  });

  test("reserveRejectsReplayAfterSettlement", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const input = reservation();
      const unit = await reserveWorkUnit(db, input);
      await transitionWorkUnit(db, {
        unitId: unit.id, expectedState: "RESERVED", unitFence: 1, nextState: "FAILED",
        patch: { kind: "dispatch_failed", errorJson: "{}" },
      });
      await expect(reserveWorkUnit(db, input)).rejects.toBeInstanceOf(CallSettledError);
    });
  });

  test("reserveRejectsSameIdemKeyWithDifferentCallId", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await reserveWorkUnit(db, reservation());
      await expect(reserveWorkUnit(db, reservation("p", { callId: "call-2" })))
        .rejects.toBeInstanceOf(IdempotencyConflictError);
    });
  });

  test("reserveEnforcesDerivedBudget", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db, { budgetLimit: 3 });
      await reserveWorkUnit(db, reservation("p", { budgetCharge: 2 }));
      await expect(reserveWorkUnit(db, reservation("p", {
        callId: "call-2", idemKey: "idem-2", cellId: "cell-2", budgetCharge: 1.01,
      }))).rejects.toBeInstanceOf(BudgetExceededError);
      expect(await getMissionBudgetUsed(db, "mission-pk-mission")).toBe(2);
    });
  });

  test("totalPolicyBudgetGateRejectsChargedOverage", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await setBudgetPolicy(db, { total: 3, perCellIterations: 10, workerShare: null, version: 1 });
      await reserveWorkUnit(db, reservation("p", { budgetCharge: 2 }));
      await expect(reserveWorkUnit(db, reservation("p", { callId: "call-2", idemKey: "idem-2", cellId: "cell-2", budgetCharge: 1.01 })))
        .rejects.toMatchObject({ name: "BudgetGateError", gate: "total" });
    });
  });

  test("perCellPolicyCountsChargedTerminalAndRetryUnitsOnly", async () => {
    await withWorkUnitDb(async (db) => {
      const missionPk = await seedMission(db);
      await setBudgetPolicy(db, { total: 20, perCellIterations: 1, workerShare: null, version: 1 });
      await db.query(
        `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, retry_of, state, fence, budget_charge, legacy_source, created_at, updated_at)
         VALUES ('charged-old', 'p', ?, 'old-call', 'cell-1', 'old-idem', 1, NULL, 'REVOKED', 1, 0.5, 'legacy', 0, 0)`,
        [missionPk],
      );
      await db.query(
        `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, retry_of, state, fence, budget_charge, created_at, updated_at)
         VALUES ('charged-retry', 'p', ?, 'retry-call', 'cell-1', 'retry-idem', 2, 'charged-old', 'FAILED', 1, 0.5, 0, 0)`,
        [missionPk],
      );
      await expect(reserveWorkUnit(db, reservation("p", { callId: "next", idemKey: "next-idem", budgetCharge: 0.25 })))
        .rejects.toMatchObject({ name: "BudgetGateError", gate: "cell" });
      const followup = await reserveWorkUnit(db, reservation("p", { callId: "read-only", idemKey: "read-only-idem", budgetCharge: 0 }));
      expect(followup.budget_charge).toBe(0);
    });
  });

  test("zeroChargeReadOnlyFollowupDoesNotConsumePerCellIteration", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await setBudgetPolicy(db, { total: 5, perCellIterations: 1, workerShare: null, version: 1 });
      const original = await reserveWorkUnit(db, reservation());
      await db.query("UPDATE swarmx_work_units SET state = 'DONE' WHERE id = ?", [original.id]);
      const followup = await reserveWorkUnit(db, reservation("p", { callId: "followup", idemKey: "followup-idem", budgetCharge: 0 }));
      expect(followup.state).toBe("RESERVED");
    });
  });

  test("sharePolicyEnforcesBoundaryOnlyForConfiguredAgent", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await setBudgetPolicy(db, { total: 20, perCellIterations: 20, workerShare: { agent: "agent-1", maxFraction: 0.5 }, version: 1 });
      const otherAgent = await reserveWorkUnit(db, reservation("p", { workerAgent: "agent-2", budgetCharge: 2 }));
      await db.query("UPDATE swarmx_work_units SET state = 'DONE' WHERE id = ?", [otherAgent.id]);
      const boundary = await reserveWorkUnit(db, reservation("p", { callId: "boundary", idemKey: "boundary-idem", cellId: "cell-2", budgetCharge: 2 }));
      expect(boundary.worker_agent).toBe("agent-1");
      await expect(reserveWorkUnit(db, reservation("p", { callId: "over", idemKey: "over-idem", cellId: "cell-3", budgetCharge: 1 })))
        .rejects.toMatchObject({ name: "BudgetGateError", gate: "share" });
      const nonPolicyAgent = await reserveWorkUnit(db, reservation("p", { workerAgent: "agent-2", callId: "non-policy", idemKey: "non-policy-idem", cellId: "cell-4", budgetCharge: 1 }));
      expect(nonPolicyAgent.worker_agent).toBe("agent-2");
    });
  });

  test("nullPolicyUsesLegacyBudgetLimitAndMalformedOrUnsupportedPolicyFailsClosed", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db, { budgetLimit: 2 });
      await reserveWorkUnit(db, reservation("p", { budgetCharge: 2 }));
      await expect(reserveWorkUnit(db, reservation("p", { callId: "legacy-over", idemKey: "legacy-over", cellId: "cell-2", budgetCharge: 0.1 })))
        .rejects.toBeInstanceOf(BudgetExceededError);

      await db.query("UPDATE swarmx_missions SET budget_policy_json = ? WHERE id = ?", ["{bad-json", "mission-pk-mission"]);
      await expect(reserveWorkUnit(db, reservation("p", { callId: "bad-json", idemKey: "bad-json", cellId: "cell-3" })))
        .rejects.toBeInstanceOf(BudgetPolicyError);
      await setBudgetPolicy(db, { total: 10, perCellIterations: 10, workerShare: null, version: 2 });
      await expect(reserveWorkUnit(db, reservation("p", { callId: "bad-version", idemKey: "bad-version", cellId: "cell-4" })))
        .rejects.toBeInstanceOf(BudgetPolicyError);
    });
  });

  test("assignmentGateRejectsOnlyOwnedAssignedDifferentAgent", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await setBudgetPolicy(db, { total: 20, perCellIterations: 20, workerShare: null, version: 1 });
      await setAssignment(db, "assigned-mismatch", { state: "assigned", owner: "owner", agent: "agent-2" });
      await expect(reserveWorkUnit(db, reservation("p", { cellId: "assigned-mismatch" })))
        .rejects.toBeInstanceOf(AssignmentMismatchError);
      const allowed = [
        { cellId: "no-row", row: null },
        { cellId: "unowned", row: { state: "assigned", owner: null, agent: "agent-2" } },
        { cellId: "agent-null", row: { state: "assigned", owner: "owner", agent: null } },
        { cellId: "released", row: { state: "released", owner: "owner", agent: "agent-2" } },
        { cellId: "legacy-ambiguous", row: { state: "legacy_ambiguous", owner: "owner", agent: "agent-2" } },
        { cellId: "null-state", row: { state: null, owner: "owner", agent: "agent-2" } },
        { cellId: "matching", row: { state: "assigned", owner: "owner", agent: "agent-1" } },
      ];
      for (const entry of allowed) {
        if (entry.row !== null) await setAssignment(db, entry.cellId, entry.row);
        const unit = await reserveWorkUnit(db, reservation("p", {
          cellId: entry.cellId, callId: `call-${entry.cellId}`, idemKey: `idem-${entry.cellId}`, budgetCharge: 0,
        }));
        expect(unit.cell_id).toBe(entry.cellId);
      }
    });
  });

  test("bindRequiresTheAgentReservedOnTheWorkUnitAndMismatchWritesNothing", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const reserved = await reserveWorkUnit(db, reservation());
      await expect(bindWorkUnit(db, {
        unitId: reserved.id, expectedState: "RESERVED", unitFence: 1,
        workerSessionId: "worker-session", workerAgent: "agent-2",
      })).rejects.toBeInstanceOf(AssignmentMismatchError);
      expect(await getWorkUnit(db, reserved.id)).toMatchObject({ state: "RESERVED", fence: 1, worker_agent: "agent-1" });
      const bound = await bindWorkUnit(db, {
        unitId: reserved.id, expectedState: "RESERVED", unitFence: 1,
        workerSessionId: "worker-session", workerAgent: "agent-1",
      });
      expect(bound.worker_agent).toBe("agent-1");
    });
  });

  test("retryUsesExplicitAgentAndRechecksBudgetAndAssignmentGates", async () => {
    await withWorkUnitDb(async (db) => {
      const missionPk = await seedMission(db);
      await setBudgetPolicy(db, { total: 2, perCellIterations: 2, workerShare: { agent: "agent-2", maxFraction: 0.5 }, version: 1 });
      const original = await reserveWorkUnit(db, reservation("p", { budgetCharge: 1 }));
      await db.query("UPDATE swarmx_work_units SET state = 'FAILED', worker_agent = 'agent-1' WHERE id = ?", [original.id]);
      const retried = await retryWorkUnit(db, {
        priorUnitId: original.id, sessionId: "session", workerAgent: "agent-2", callId: "retry-call",
        dispatchToken: "retry-dispatch", budgetCharge: 1,
      });
      expect(retried.worker_agent).toBe("agent-2");
      await db.query("UPDATE swarmx_work_units SET state = 'FAILED' WHERE id = ?", [retried.id]);
      await expect(retryWorkUnit(db, {
        priorUnitId: retried.id, sessionId: "session", workerAgent: "agent-2", callId: "retry-over-budget",
        dispatchToken: "retry-dispatch-over-budget", budgetCharge: 1,
      })).rejects.toMatchObject({ name: "BudgetGateError", gate: "total" });
      await setBudgetPolicy(db, { total: 5, perCellIterations: 2, workerShare: { agent: "agent-2", maxFraction: 0.5 }, version: 1 });
      await setAssignment(db, "cell-1", { state: "assigned", owner: "owner", agent: "agent-1" });
      await expect(retryWorkUnit(db, {
        priorUnitId: retried.id, sessionId: "session", workerAgent: "agent-2", callId: "retry-blocked",
        dispatchToken: "retry-dispatch-2", budgetCharge: 1,
      })).rejects.toBeInstanceOf(AssignmentMismatchError);
      const units = await db.query("SELECT id, worker_agent FROM swarmx_work_units WHERE mission_pk = ?", [missionPk]);
      expect(units.rows).toHaveLength(2);
    });
  });

  test("existingReservationDiagnosticsPrecedePolicyAssignmentAndBudgetGates", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const original = await reserveWorkUnit(db, reservation());
      await setAssignment(db, "cell-1", { state: "assigned", owner: "owner", agent: "wrong-agent" });
      await db.query("UPDATE swarmx_missions SET budget_policy_json = ? WHERE id = ?", ["broken", "mission-pk-mission"]);
      await expect(reserveWorkUnit(db, reservation("p", { dispatchToken: "changed" })))
        .rejects.toBeInstanceOf(ReservationConflictError);
      await expect(reserveWorkUnit(db, reservation("p", { callId: "different-call", idemKey: "idem-1", cellId: "cell-2" })))
        .rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(reserveWorkUnit(db, reservation("p", { callId: "cell-call", idemKey: "cell-idem" })))
        .rejects.toBeInstanceOf(CellBusyError);
      await db.query("UPDATE swarmx_missions SET state = 'CLOSING' WHERE id = ?", ["mission-pk-mission"]);
      await expect(reserveWorkUnit(db, reservation("p", { callId: "closed", idemKey: "closed", cellId: "cell-3" })))
        .rejects.toBeInstanceOf(MissionClosedError);
      expect(await getWorkUnit(db, original.id)).not.toBeNull();
    });
  });

  test("onlyOneLiveUnitPerProjectCell", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      await reserveWorkUnit(db, reservation());
      await expect(reserveWorkUnit(db, reservation("p", { callId: "call-2", idemKey: "idem-2" })))
        .rejects.toBeInstanceOf(CellBusyError);
    });
  });

  test("bindStoresWorkerSessionAndAgent", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const reserved = await reserveWorkUnit(db, reservation());
      const bound = await bindWorkUnit(db, {
        unitId: reserved.id, expectedState: "RESERVED", unitFence: 1,
        workerSessionId: "worker-session", workerAgent: "agent-1",
      });
      expect(bound).toMatchObject({ state: "BOUND", fence: 2, worker_session: "worker-session", worker_agent: "agent-1" });
    });
  });

  test("needsChangesRetryCreatesNewUnitAfterFeedback", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db, { budgetLimit: 10 });
      const original = await reserveWorkUnit(db, reservation());
      await db.query("UPDATE swarmx_work_units SET state = 'CHANGES_REQUESTED', reason = 'preserve this feedback' WHERE id = ?", [original.id]);
      const retried = await retryWorkUnit(db, {
        priorUnitId: original.id, sessionId: "session", workerAgent: "agent-2", callId: "call-2", dispatchToken: "dispatch-2", budgetCharge: 3,
      });
      const expectedIdem = createHash("sha256").update("p|mission|cell-1|2").digest("hex");
      expect(retried).toMatchObject({
        id: "unit:p:mission:call-2", retry_of: original.id, attempt_no: 2, idem_key: expectedIdem,
        budget_charge: 3, dispatch_token: "dispatch-2", state: "RESERVED",
      });
      expect((await getWorkUnit(db, original.id))?.reason).toBe("preserve this feedback");
      expect(await getMissionBudgetUsed(db, "mission-pk-mission")).toBe(5);
    });
  });

  test("retryRejectsNonRetryablePredecessor", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const original = await reserveWorkUnit(db, reservation());
      await expect(retryWorkUnit(db, {
        priorUnitId: original.id, sessionId: "session", workerAgent: "agent-2", callId: "call-2", dispatchToken: "dispatch-2", budgetCharge: 1,
      })).rejects.toBeInstanceOf(RetryNotAllowedError);
    });
  });

  test("legacyOwnershipAmbiguityIsNonDestructive", async () => {
    await withWorkUnitDb(async (db) => {
      await recordLegacyAssignment(db, { project: "p", cellId: "legacy-cell" });
      await recordLegacyAssignment(db, { project: "p", cellId: "legacy-cell" });
      expect((await db.query("SELECT project, cell_id, owner FROM swarmx_legacy_assignments")).rows).toEqual([
        { project: "p", cell_id: "legacy-cell", owner: null },
      ]);
      expect((await db.query("SELECT id FROM swarmx_work_units")).rows).toHaveLength(0);
      await seedMission(db);
      const live = await reserveWorkUnit(db, reservation("p", { cellId: "legacy-cell" }));
      expect(live.state).toBe("RESERVED");
    });
  });
});

const LIVE_STATES = ["RESERVED", "BOUND", "SUBMITTED", "IN_REVIEW", "APPROVED", "PUBLISHING", "RETURNING"];

async function seedCloseUnit(db: DatabaseAdapter, missionPk: string, id: string, state: WorkUnitState): Promise<void> {
  await db.query(
    "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, 1, ?, 3, 0, 0)",
    [id, missionPk, `call-${id}`, `idem-${id}`, state],
  );
}

async function unitStates(db: DatabaseAdapter): Promise<Record<string, unknown>> {
  const result = await db.query("SELECT id, state FROM swarmx_work_units ORDER BY id");
  return Object.fromEntries(result.rows.map((row) => [rowValue(row, "id"), rowValue(row, "state")]));
}

async function terminalMissionsWithLiveUnits(db: DatabaseAdapter): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(u.id) AS n FROM swarmx_missions m JOIN swarmx_work_units u ON u.mission_pk = m.id
     WHERE m.state IN ('FINISHED', 'CANCELLED', 'ABANDONED') AND u.state IN (${LIVE_STATES.map(() => "?").join(", ")})`,
    LIVE_STATES,
  );
  return Number(rowValue(result.rows[0], "n"));
}

describe("mission close barrier", () => {
  const owner = { missionPk: "mission-pk-mission", ownerSessionId: "session" };

  test("closeBlocksNewReservations immediately after OPEN -> CLOSING", async () => {
    await withWorkUnitDb(async (db) => {
      await seedMission(db);
      const closing = await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "finish" });
      expect(closing).toMatchObject({ state: "CLOSING", close_intent: "finish", fence: 2 });
      await expect(reserveWorkUnit(db, reservation())).rejects.toBeInstanceOf(MissionClosedError);
      expect(await unitStates(db)).toEqual({});
    });
  });

  test("stale fence or non-owner cannot begin, cascade, or finish close", async () => {
    await withWorkUnitDb(async (db) => {
      const pk = await seedMission(db);
      await seedCloseUnit(db, pk, "u1", "BOUND");
      await expect(beginMissionClose(db, { ...owner, ownerSessionId: "intruder", expectedFence: 1, intent: "cancel" }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      await expect(beginMissionClose(db, { ...owner, expectedFence: 0, intent: "cancel" }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "cancel" });
      await expect(cascadeMissionClose(db, { ...owner, expectedFence: 1, intent: "cancel" }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      await expect(cascadeMissionClose(db, { ...owner, ownerSessionId: "intruder", expectedFence: 2, intent: "cancel" }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      await expect(cascadeMissionClose(db, { ...owner, expectedFence: 2, intent: "abandon" }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      await expect(finishMissionClose(db, { ...owner, ownerSessionId: "intruder", expectedFence: 2 }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      expect(await unitStates(db)).toEqual({ u1: "BOUND" });
    });
  });

  test("closeWaitsForLiveUnits and finishes only after they settle", async () => {
    await withWorkUnitDb(async (db) => {
      const pk = await seedMission(db);
      await seedCloseUnit(db, pk, "u1", "BOUND");
      await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "finish" });
      await expect(finishMissionClose(db, { ...owner, expectedFence: 2 })).rejects.toBeInstanceOf(MissionNotDrainedError);
      expect(await terminalMissionsWithLiveUnits(db)).toBe(0);
      await db.query("UPDATE swarmx_work_units SET state = 'DONE' WHERE id = 'u1'");
      const done = await finishMissionClose(db, { ...owner, expectedFence: 2 });
      expect(done).toMatchObject({ state: "FINISHED", fence: 3 });
      expect(await finishMissionClose(db, { ...owner, expectedFence: 2 })).toMatchObject({ state: "FINISHED", fence: 3 });
    });
  });

  test("closeThenCascadeCrashIsRecoverable and cascade is idempotent", async () => {
    await withWorkUnitDb(async (db) => {
      const pk = await seedMission(db);
      for (const state of ["RESERVED", "BOUND", "SUBMITTED", "IN_REVIEW"] as const) {
        await seedCloseUnit(db, pk, state.toLowerCase(), state);
      }
      await seedCloseUnit(db, pk, "done", "DONE");
      await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "abandon" });
      // crash between begin and cascade: retrying begin with the old fence is a no-op replay
      expect(await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "abandon" }))
        .toMatchObject({ state: "CLOSING", close_intent: "abandon", fence: 2 });
      await expect(beginMissionClose(db, { ...owner, expectedFence: 1, intent: "finish" }))
        .rejects.toBeInstanceOf(MissionFenceConflictError);
      const first = await cascadeMissionClose(db, { ...owner, expectedFence: 2, intent: "abandon" });
      expect(first.unitIds.sort()).toEqual(["bound", "in_review", "reserved", "submitted"]);
      expect(await cascadeMissionClose(db, { ...owner, expectedFence: 2, intent: "abandon" })).toEqual({ unitIds: [] });
      expect(await unitStates(db)).toEqual({
        bound: "ABANDONED", done: "DONE", in_review: "ABANDONED", reserved: "ABANDONED", submitted: "ABANDONED",
      });
      expect(await finishMissionClose(db, { ...owner, expectedFence: 2 })).toMatchObject({ state: "ABANDONED" });
      expect(await terminalMissionsWithLiveUnits(db)).toBe(0);
    });
  });

  test("cancelCancelsApprovedWithoutEffects but keeps approved units with issued effects", async () => {
    await withWorkUnitDb(async (db) => {
      const pk = await seedMission(db);
      await seedCloseUnit(db, pk, "bare", "APPROVED");
      await seedCloseUnit(db, pk, "issued", "APPROVED");
      await db.query(
        "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('e1', 'issued', 'backend_complete', 1, 3, 'pending', 0, 0)",
      );
      await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "cancel" });
      expect(await cascadeMissionClose(db, { ...owner, expectedFence: 2, intent: "cancel" })).toEqual({ unitIds: ["bare"] });
      expect(await unitStates(db)).toEqual({ bare: "CANCELLED", issued: "APPROVED" });
      await expect(finishMissionClose(db, { ...owner, expectedFence: 2 })).rejects.toBeInstanceOf(MissionNotDrainedError);
    });
  });

  test("cancelDrainsPublishingAndReturning instead of cancelling them", async () => {
    await withWorkUnitDb(async (db) => {
      const pk = await seedMission(db);
      await seedCloseUnit(db, pk, "pub", "PUBLISHING");
      await seedCloseUnit(db, pk, "ret", "RETURNING");
      await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "cancel" });
      expect(await cascadeMissionClose(db, { ...owner, expectedFence: 2, intent: "cancel" })).toEqual({ unitIds: [] });
      expect(await unitStates(db)).toEqual({ pub: "PUBLISHING", ret: "RETURNING" });
      await expect(finishMissionClose(db, { ...owner, expectedFence: 2 })).rejects.toBeInstanceOf(MissionNotDrainedError);
      await transitionWorkUnit(db, { unitId: "pub", expectedState: "PUBLISHING", unitFence: 3, nextState: "DONE", patch: { kind: "finalize" } });
      await transitionWorkUnit(db, { unitId: "ret", expectedState: "RETURNING", unitFence: 3, nextState: "CHANGES_REQUESTED", patch: { kind: "finalize_return" } });
      expect(await finishMissionClose(db, { ...owner, expectedFence: 2 })).toMatchObject({ state: "CANCELLED" });
      expect(await terminalMissionsWithLiveUnits(db)).toBe(0);
    });
  });
});
