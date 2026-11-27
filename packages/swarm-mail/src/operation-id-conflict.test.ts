import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLibSQLAdapter } from "./libsql.js";
import type { DatabaseAdapter } from "./types/database.js";
import {
  OperationIdConflictError,
  isOperationIdUniqueViolation,
} from "./operation-id-conflict.js";

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to fail");
}

describe("operation-id conflict detection", () => {
  let db: DatabaseAdapter;

  beforeAll(async () => {
    db = await createLibSQLAdapter({ url: ":memory:" });
    await db.exec(
      "CREATE TABLE ops (id INTEGER PRIMARY KEY, operation_id TEXT, other TEXT NOT NULL)",
    );
    await db.exec(
      "CREATE UNIQUE INDEX idx_ops_operation_id ON ops(operation_id) WHERE operation_id IS NOT NULL",
    );
    await db.exec("CREATE TABLE plain (code TEXT UNIQUE)");
    await db.query("INSERT INTO ops (operation_id, other) VALUES ('op-1', 'x')");
    await db.query("INSERT INTO plain (code) VALUES ('c')");
  });

  afterAll(async () => {
    await db.close?.();
  });

  test("matchesOnlyTheExpectedTableAndColumn", async () => {
    const error = await captureError(() =>
      db.query("INSERT INTO ops (operation_id, other) VALUES ('op-1', 'y')"),
    );
    expect(isOperationIdUniqueViolation(error, "ops")).toBe(true);
    expect(isOperationIdUniqueViolation(error, "beads")).toBe(false);
    expect(isOperationIdUniqueViolation(error, "ops", "other")).toBe(false);
  });

  test("ignoresUniqueViolationsOnOtherColumns", async () => {
    const error = await captureError(() => db.query("INSERT INTO plain (code) VALUES ('c')"));
    expect(isOperationIdUniqueViolation(error, "plain")).toBe(false);
    expect(isOperationIdUniqueViolation(error, "plain", "code")).toBe(true);
  });

  test("ignoresNonUniqueConstraintFailures", async () => {
    const error = await captureError(() =>
      db.query("INSERT INTO ops (operation_id, other) VALUES ('op-2', NULL)"),
    );
    expect(isOperationIdUniqueViolation(error, "ops")).toBe(false);
  });

  test("ignoresMessageOnlyLookalikesWithoutDriverCode", () => {
    const fake = new Error("UNIQUE constraint failed: ops.operation_id");
    expect(isOperationIdUniqueViolation(fake, "ops")).toBe(false);
  });

  test("conflictErrorCarriesOperationIdTableAndCause", () => {
    const cause = new Error("driver");
    const error = new OperationIdConflictError("op-9", cause, "messages");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OperationIdConflictError");
    expect(error.operationId).toBe("op-9");
    expect(error.table).toBe("messages");
    expect(error.cause).toBe(cause);
  });
});
