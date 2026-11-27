/**
 * Shared typing for `operation_id` idempotency-key conflicts.
 *
 * A conflict is recognised only from driver evidence: the SQLite extended
 * result code must be SQLITE_CONSTRAINT_UNIQUE and the violated constraint
 * must be exactly `<table>.<column>` (SQLite reports
 * `UNIQUE constraint failed: <table>.<col>`). Message text alone never matches.
 */

/** SQLite extended result code SQLITE_CONSTRAINT_UNIQUE */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export class OperationIdConflictError extends Error {
  readonly operationId: string;
  readonly table: string;
  constructor(operationId: string, cause: unknown, table = "beads") {
    super(
      table === "beads"
        ? `[BeadsStore] operation_id already used: ${operationId}`
        : `[${table}] operation_id already used: ${operationId}`,
      { cause },
    );
    this.name = "OperationIdConflictError";
    this.operationId = operationId;
    this.table = table;
  }
}

/**
 * True when `error` (or one of its causes) is a driver UNIQUE violation on
 * exactly `<table>.<column>`.
 */
export function isOperationIdUniqueViolation(
  error: unknown,
  table: string,
  column = "operation_id",
): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; rawCode?: unknown; message?: unknown };
    const isUnique = e.rawCode === SQLITE_CONSTRAINT_UNIQUE || e.code === "SQLITE_CONSTRAINT_UNIQUE";
    if (isUnique) {
      const detail = String(e.message ?? "").split("UNIQUE constraint failed:")[1]?.trim();
      return detail === `${table}.${column}`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
