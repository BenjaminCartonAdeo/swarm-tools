import { describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import { FenceConflictError, getMissionBudgetUsed, InvalidPatchError, transitionWorkUnit } from "../src/workunit/store.js";
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

function rowValue(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null || !(key in row)) {
    return undefined;
  }
  return Reflect.get(row, key);
}

describe("WorkUnit schema", () => {
  test("schemaCreatesFiveTablesAndRequiredIndexes", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });

    try {
      await ensureWorkUnitSchema(db);
      await ensureWorkUnitSchema(db);

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
