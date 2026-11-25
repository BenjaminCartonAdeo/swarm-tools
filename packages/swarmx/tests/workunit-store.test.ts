import { describe, expect, test } from "bun:test";
import { createLibSQLAdapter } from "../../swarm-mail/src/index.js";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";

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

      await db.exec(
        "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m1', 'p', 's', 'x', 'OPEN', 1, 0, 0)",
      );
      await expect(
        db.exec(
          "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m2', 'p', 's', 'y', 'CLOSING', 1, 0, 0)",
        ),
      ).rejects.toThrow();
      await db.exec(
        "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m3', 'p', 's', 'z', 'FINISHED', 1, 0, 0)",
      );
      await expect(
        db.exec(
          "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('m4', 'p', 's', 'x', 'FINISHED', 1, 0, 0)",
        ),
      ).rejects.toThrow();

      await db.exec(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u1', 'p', 'm1', 'call1', 'idem1', 1, 'RESERVED', 1, 0, 0)",
      );
      for (const [id, callId, idemKey] of [
        ["u2", "call1", "idem2"],
        ["u3", "call3", "idem1"],
      ]) {
        await expect(
          db.exec(
            `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('${id}', 'p', 'm1', '${callId}', '${idemKey}', 1, 'BOUND', 1, 0, 0)`,
          ),
        ).rejects.toThrow();
      }
      await db.exec(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u4', 'p', 'm1', 'call4', 'cell1', 'idem4', 1, 'RESERVED', 1, 0, 0)",
      );
      await expect(
        db.exec(
          "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u5', 'p', 'm1', 'call5', 'cell1', 'idem5', 1, 'SUBMITTED', 1, 0, 0)",
        ),
      ).rejects.toThrow();
      await db.exec("UPDATE swarmx_work_units SET state = 'DONE' WHERE id = 'u4'");
      await db.exec(
        "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('u6', 'p', 'm1', 'call6', 'cell1', 'idem6', 1, 'RESERVED', 1, 0, 0)",
      );

      await db.exec(
        "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('e1', 'u1', 'backend_complete', 1, 1, 'pending', 0, 0)",
      );
      await expect(
        db.exec(
          "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('e2', 'u1', 'backend_complete', 1, 1, 'pending', 0, 0)",
        ),
      ).rejects.toThrow();
      const effectId = await db.query("PRAGMA table_info(swarmx_effects)");
      expect(
        effectId.rows.find((row) => rowValue(row, "name") === "effect_id")
          ? rowValue(effectId.rows.find((row) => rowValue(row, "name") === "effect_id"), "pk")
          : undefined,
      ).toBe(1);

      await db.exec(
        "INSERT INTO swarmx_locks (name, token, owner_session, fence, acquired_at) VALUES ('global', 't1', 's1', 1, 0)",
      );
      await expect(
        db.exec(
          "INSERT INTO swarmx_locks (name, token, owner_session, fence, acquired_at) VALUES ('global', 't2', 's2', 2, 0)",
        ),
      ).rejects.toThrow();

      await db.exec(
        "INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, raw_json, created_at) VALUES ('p', 'legacy-cell', NULL, '{}', 0)",
      );
      await expect(
        db.exec(
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
