/**
 * Beads Event Store - Drizzle ORM Implementation
 *
 * Drizzle-based implementation of cell event store operations.
 * Replaces raw SQL queries with type-safe Drizzle query builder.
 *
 * ## Architecture
 * - Cell events stored in shared `events` table (same as agent/message events)
 * - Events trigger updateProjections() to update materialized views
 * - Events are NOT replayed for state (hybrid model - projections are source of truth)
 * - Event log provides audit trail and debugging for swarm coordination
 *
 * ## Event Flow
 * 1. appendCellEvent() -> INSERT INTO events
 * 2. updateProjections() -> UPDATE materialized views (beads, dependencies, labels, etc.)
 * 3. Query operations read from projections (fast)
 *
 * @module beads/store
 */

import { randomUUID } from "node:crypto";
import { and, eq, gte, gt, inArray, lte, sql } from "drizzle-orm";
import type { SwarmDb } from "../db/client.js";
import { eventsTable } from "../db/schema/streams.js";
import { withTiming } from "../streams/index.js";
import type { DatabaseAdapter } from "../types/database.js";
import { buildCellCreatedProjectionStatements, updateProjectionsDrizzle } from "./projections-drizzle.js";
import type { CellEvent } from "./events.js";
import { OperationIdConflictError, isOperationIdUniqueViolation } from "../operation-id-conflict.js";

/**
 * Typed conflict: a cell_created lost the unique race on beads.operation_id.
 * The whole batch (event + projection) was rolled back.
 */
export { OperationIdConflictError };

async function resolveSequence(db: SwarmDb, id: number, sequence: number | null): Promise<number> {
  if (sequence != null) return sequence;
  // LibSQL workaround: RETURNING gives pre-trigger value
  const seqResult = await db
    .select({ sequence: eventsTable.sequence })
    .from(eventsTable)
    .where(eq(eventsTable.id, id));
  return seqResult[0]?.sequence ?? id;
}

// No type guards needed - CellEvent type is already defined

// ============================================================================
// Timestamp Parsing (same as streams/store.ts)
// ============================================================================

/**
 * Parse timestamp from database row.
 *
 * Timestamps are stored as BIGINT but parsed as JavaScript number.
 * Safe for dates before year 2286 (MAX_SAFE_INTEGER).
 */
function parseTimestamp(timestamp: string | number): number {
  const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
  if (Number.isNaN(ts)) {
    throw new Error(`[BeadsStore] Invalid timestamp: ${timestamp}`);
  }
  if (ts > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `[BeadsStore] Timestamp ${timestamp} exceeds MAX_SAFE_INTEGER (year 2286+)`,
    );
  }
  return ts;
}

// ============================================================================
// Event Store Operations (Drizzle)
// ============================================================================

/**
 * Options for reading cell events
 */
export interface ReadCellEventsOptions {
  /** Filter by project key */
  projectKey?: string;
  /** Filter by cell ID */
  cellId?: string;
  /** Filter by event types */
  types?: CellEvent["type"][];
  /** Events after this timestamp */
  since?: number;
  /** Events before this timestamp */
  until?: number;
  /** Events after this sequence number */
  afterSequence?: number;
  /** Maximum number of events to return */
  limit?: number;
  /** Skip this many events (pagination) */
  offset?: number;
}

/**
 * Append a cell event using Drizzle
 *
 * @param db - Drizzle database instance
 * @param event - Cell event to append
 * @returns Event with id and sequence
 */
export async function appendCellEventDrizzle(
  db: SwarmDb,
  event: CellEvent,
): Promise<CellEvent & { id: number; sequence: number }> {
  const { type, project_key, timestamp, ...rest } = event;

  const insertEvent = db
    .insert(eventsTable)
    .values({
      type,
      project_key,
      timestamp,
      data: JSON.stringify(rest),
      // sequence omitted - auto-assigned by database (SERIAL in PGlite, trigger in LibSQL)
    })
    .returning({ id: eventsTable.id, sequence: eventsTable.sequence });

  if (type === "cell_created") {
    // Atomic path: event insert + beads row + dirty marker run in ONE
    // db.batch() (single BEGIN/COMMIT on the same connection). If the beads
    // insert fails (e.g. idx_beads_operation_id) the event insert rolls back,
    // so no orphan cell_created event can exist.
    const [beadInsert, dirtyInsert] = buildCellCreatedProjectionStatements(db, event as any);
    let batchResult: Array<{ id: number; sequence: number | null }>;
    try {
      [batchResult] = await db.batch([insertEvent, beadInsert, dirtyInsert]);
    } catch (error) {
      if (isOperationIdUniqueViolation(error, "beads")) {
        throw new OperationIdConflictError(
          (event as { operation_id?: string }).operation_id ?? "",
          error,
        );
      }
      throw error;
    }
    const created = batchResult[0];
    if (!created) {
      throw new Error("[BeadsStore] Failed to insert event - no row returned");
    }
    const sequence = await resolveSequence(db, created.id, created.sequence);
    return { ...event, id: created.id, sequence };
  }

  if (type === "cell_closed") {
    return appendGuardedCellClosed(db, event, rest);
  }

  // Insert event
  const result = await insertEvent;

  const row = result[0];
  if (!row) {
    throw new Error("[BeadsStore] Failed to insert event - no row returned");
  }

  let { id, sequence } = row;

  // LibSQL workaround: RETURNING gives pre-trigger value, sequence may be null
  // If sequence is null, fetch it after trigger has run
  if (sequence == null) {
    const seqResult = await db
      .select({ sequence: eventsTable.sequence })
      .from(eventsTable)
      .where(eq(eventsTable.id, id));
    sequence = seqResult[0]?.sequence ?? id; // Fallback to id if still null
  }

  // Update materialized views based on event type
  await updateProjectionsDrizzle(db, { ...event, id, sequence } as any);

  return { ...event, id, sequence };
}

/**
 * Thrown by the guarded close when its event insert lost the guard (cell not
 * open, or identity already set, or cell missing). The whole batch was a no-op.
 * The adapter re-reads the cell to classify the outcome.
 */
export class CellCloseRejectedError extends Error {
  readonly cellId: string;
  constructor(cellId: string) {
    super(`[BeadsStore] close rejected by guard: ${cellId}`);
    this.name = "CellCloseRejectedError";
    this.cellId = cellId;
  }
}

/** Thrown when an operation targets a cell that does not exist. */
export class CellNotFoundError extends Error {
  readonly cellId: string;
  constructor(cellId: string) {
    super(`[HiveAdapter] Bead not found: ${cellId}`);
    this.name = "CellNotFoundError";
    this.cellId = cellId;
  }
}

/**
 * Atomic, conflict-safe close. One db.batch (single BEGIN/COMMIT):
 *   1. guarded event insert (cell open and, for identity closes, identity unset),
 *      carrying a unique internal `event_token`;
 *   2. beads update;
 *   3-4. blocked-cache rebuild for the closed cell and its direct dependents
 *      (same semantics as invalidateBlockedCacheDrizzle);
 *   5. dirty marker.
 * Statements 2-5 are gated on the existence of this exact event_token, so a
 * losing insert makes the whole batch a no-op. Replay/rebuild still uses the
 * shared projection path (handleBeadClosedDrizzle), which ignores event_token.
 */
async function appendGuardedCellClosed(
  db: SwarmDb,
  event: CellEvent,
  rest: Record<string, unknown>,
): Promise<CellEvent & { id: number; sequence: number }> {
  const { type, project_key, timestamp } = event;
  const cellId = event.cell_id;
  const rawIdentity = (event as { completion_operation_id?: unknown }).completion_operation_id;
  const identity = typeof rawIdentity === "string" && rawIdentity.length > 0 ? rawIdentity : null;
  const eventToken = typeof rest.event_token === "string" ? rest.event_token : randomUUID();
  const data = JSON.stringify({ ...rest, event_token: eventToken });
  const reason = (event as { reason?: string | null }).reason ?? null;
  const rawResult = (event as { result?: unknown }).result;
  // Truthy-result semantics, as in handleBeadClosedDrizzle (`if (result)`).
  const result = typeof rawResult === "string" && rawResult.length > 0 ? rawResult : null;
  const identityGuard = identity === null ? sql`` : sql` AND completion_operation_id IS NULL`;
  const thisEvent = sql`EXISTS (
    SELECT 1 FROM events WHERE type = 'cell_closed' AND json_extract(data, '$.event_token') = ${eventToken}
  )`;
  const targets = sql`targets(id) AS (
    SELECT ${cellId}
    UNION
    SELECT cell_id FROM bead_dependencies WHERE depends_on_id = ${cellId}
  )`;

  const statements = [
    db.run(sql`
      INSERT INTO events (type, project_key, timestamp, data)
      SELECT ${type}, ${project_key}, ${timestamp}, ${data}
      WHERE EXISTS (SELECT 1 FROM beads WHERE id = ${cellId} AND status <> 'closed'${identityGuard})
    `),
    db.run(sql`
      UPDATE beads SET status = 'closed', closed_at = ${timestamp}, closed_reason = ${reason},
        updated_at = ${timestamp}, completion_operation_id = COALESCE(${identity}, completion_operation_id),
        result = CASE WHEN ${result} IS NULL THEN result ELSE ${result} END,
        result_at = CASE WHEN ${result} IS NULL THEN result_at ELSE ${timestamp} END
      WHERE id = ${cellId} AND ${thisEvent}
    `),
    db.run(sql`
      WITH RECURSIVE ${targets}
      DELETE FROM blocked_beads_cache WHERE cell_id IN (SELECT id FROM targets) AND ${thisEvent}
    `),
    db.run(sql`
      WITH RECURSIVE ${targets},
      blockers(target, blocker_id, depth) AS (
        SELECT t.id, bd.depends_on_id, 1
        FROM targets t JOIN bead_dependencies bd ON bd.cell_id = t.id
        WHERE bd.relationship = 'blocks'
        UNION
        SELECT b.target, bd.depends_on_id, b.depth + 1
        FROM bead_dependencies bd JOIN blockers b ON bd.cell_id = b.blocker_id
        WHERE bd.relationship = 'blocks' AND b.depth < ${MAX_CLOSE_DEPENDENCY_DEPTH}
      ),
      open_blockers AS (
        SELECT DISTINCT b.target, b.blocker_id
        FROM blockers b JOIN beads bead ON b.blocker_id = bead.id
        WHERE bead.project_key = ${project_key} AND bead.status != 'closed' AND bead.deleted_at IS NULL
      )
      INSERT INTO blocked_beads_cache (cell_id, blocker_ids, updated_at)
      SELECT target, json_group_array(blocker_id), ${timestamp}
      FROM open_blockers
      WHERE ${thisEvent}
      GROUP BY target
    `),
    db.run(sql`
      INSERT INTO dirty_beads (cell_id, marked_at) SELECT ${cellId}, ${Date.now()} WHERE ${thisEvent}
      ON CONFLICT (cell_id) DO UPDATE SET marked_at = excluded.marked_at
    `),
  ];

  let batchResult: Array<{ rowsAffected: number; lastInsertRowid?: bigint | number }>;
  try {
    batchResult = (await db.batch(statements as any)) as unknown as typeof batchResult;
  } catch (error) {
    if (identity !== null && isOperationIdUniqueViolation(error, "beads", "completion_operation_id")) {
      throw new OperationIdConflictError(identity, error, "beads.completion");
    }
    throw error;
  }
  const inserted = batchResult[0];
  if (!inserted || inserted.rowsAffected === 0) throw new CellCloseRejectedError(cellId);
  const id = Number(inserted.lastInsertRowid);
  const sequence = await resolveSequence(db, id, null);
  return { ...event, event_token: eventToken, id, sequence } as CellEvent & { id: number; sequence: number };
}

/** Same bound as dependencies-drizzle MAX_DEPENDENCY_DEPTH. */
const MAX_CLOSE_DEPENDENCY_DEPTH = 100;

/**
 * Read cell events with optional filters using Drizzle
 *
 * @param db - Drizzle database instance
 * @param options - Filter options
 * @returns Array of cell events with id and sequence
 */
export async function readCellEventsDrizzle(
  db: SwarmDb,
  options: ReadCellEventsOptions = {},
): Promise<Array<CellEvent & { id: number; sequence: number }>> {
  const conditions = [];

  // Always filter for cell events (type starts with "cell_")
  conditions.push(sql`${eventsTable.type} LIKE 'cell_%'`);

  if (options.projectKey) {
    conditions.push(eq(eventsTable.project_key, options.projectKey));
  }

  if (options.cellId) {
    // cell_id is stored in data JSON field
    // Use json_extract for SQLite compatibility
    conditions.push(sql`json_extract(${eventsTable.data}, '$.cell_id') = ${options.cellId}`);
  }

  if (options.types && options.types.length > 0) {
    conditions.push(inArray(eventsTable.type, options.types));
  }

  if (options.since !== undefined) {
    conditions.push(gte(eventsTable.timestamp, options.since));
  }

  if (options.until !== undefined) {
    conditions.push(lte(eventsTable.timestamp, options.until));
  }

  if (options.afterSequence !== undefined) {
    conditions.push(gt(eventsTable.sequence, options.afterSequence));
  }

  let query = db
    .select()
    .from(eventsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(eventsTable.sequence)
    .$dynamic();

  if (options.limit) {
    query = query.limit(options.limit);
  }

  if (options.offset) {
    query = query.offset(options.offset);
  }

  const rows = await query;

  return rows.map((row) => {
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    return {
      id: row.id,
      type: row.type as CellEvent["type"],
      project_key: row.project_key,
      timestamp: parseTimestamp(row.timestamp),
      sequence: row.sequence ?? 0,
      ...data,
    } as CellEvent & { id: number; sequence: number };
  });
}

// ============================================================================
// Convenience Wrappers (compatible with old signatures)
// ============================================================================

/**
 * Append a cell event to the shared event store (convenience wrapper)
 *
 * Events are stored in the same `events` table as agent/message events.
 * Triggers updateProjections() to update materialized views.
 *
 * @param event - Cell event to append
 * @param projectPath - Optional project path for database location
 * @param dbOverride - Optional database adapter for dependency injection
 * @returns Event with id and sequence number
 */
export async function appendCellEvent(
  event: CellEvent,
  projectPath?: string,
  dbOverride?: DatabaseAdapter,
): Promise<CellEvent & { id: number; sequence: number }> {
  const { toDrizzleDb } = await import("../libsql.convenience.js");

  if (!dbOverride) {
    throw new Error(
      "[hive/store] dbOverride parameter is required. " +
      "PGlite getDatabase() has been removed. " +
      "Use createHiveAdapter() instead of calling appendCellEvent() directly."
    );
  }
  
  const swarmDb = toDrizzleDb(dbOverride);

  return appendCellEventDrizzle(swarmDb, event);
}

/**
 * Read cell events with optional filters (convenience wrapper)
 *
 * Queries the shared events table for cell events (type starts with "cell_").
 *
 * @param options - Filter options
 * @param projectPath - Optional project path for database location
 * @param dbOverride - Optional database adapter for dependency injection
 * @returns Array of cell events with id and sequence
 */
export async function readCellEvents(
  options: ReadCellEventsOptions = {},
  projectPath?: string,
  dbOverride?: DatabaseAdapter,
): Promise<Array<CellEvent & { id: number; sequence: number }>> {
  return withTiming("readCellEvents", async () => {
    const { toDrizzleDb } = await import("../libsql.convenience.js");

    if (!dbOverride) {
      throw new Error(
        "[hive/store] dbOverride parameter is required. " +
        "PGlite getDatabase() has been removed. " +
        "Use createHiveAdapter() instead of calling readCellEvents() directly."
      );
    }

    const swarmDb = toDrizzleDb(dbOverride);

    return readCellEventsDrizzle(swarmDb, options);
  });
}

/**
 * Replay cell events to rebuild materialized views
 *
 * Useful for:
 * - Recovering from projection corruption
 * - Migrating to new schema
 * - Debugging state issues
 *
 * Note: Unlike swarm-mail agent events, cell projections are NOT rebuilt
 * from events in normal operation (hybrid CRUD + audit trail model).
 * This function is for recovery/debugging only.
 *
 * @param options - Replay options
 * @param projectPath - Optional project path for database location
 * @param dbOverride - Optional database adapter for dependency injection
 * @returns Stats about replay operation
 */
export async function replayCellEvents(
  options: {
    projectKey?: string;
    fromSequence?: number;
    clearViews?: boolean;
  } = {},
  projectPath?: string,
  dbOverride?: DatabaseAdapter,
): Promise<{ eventsReplayed: number; duration: number }> {
  return withTiming("replayCellEvents", async () => {
    const startTime = Date.now();
    const { toDrizzleDb } = await import("../libsql.convenience.js");

    if (!dbOverride) {
      throw new Error(
        "[hive/store] dbOverride parameter is required. " +
        "PGlite getDatabase() has been removed. " +
        "Use createHiveAdapter() instead of calling replayCellEvents() directly."
      );
    }

    const swarmDb = toDrizzleDb(dbOverride);

    // Optionally clear cell-specific materialized views using Drizzle
    if (options.clearViews) {
      const { beads, beadComments, beadLabels, beadDependencies, blockedBeadsCache, dirtyBeads } = 
        await import("../db/schema/hive.js");

      if (options.projectKey) {
        // Clear for specific project using Drizzle
        // Get cell IDs for this project first
        const cellIds = await swarmDb
          .select({ id: beads.id })
          .from(beads)
          .where(eq(beads.project_key, options.projectKey));
        
        const cellIdList = cellIds.map(r => r.id);
        
        if (cellIdList.length > 0) {
          // Delete related data in proper order (foreign keys)
          await swarmDb.delete(beadComments).where(inArray(beadComments.cell_id, cellIdList));
          await swarmDb.delete(beadLabels).where(inArray(beadLabels.cell_id, cellIdList));
          await swarmDb.delete(beadDependencies).where(inArray(beadDependencies.cell_id, cellIdList));
          await swarmDb.delete(blockedBeadsCache).where(inArray(blockedBeadsCache.cell_id, cellIdList));
          await swarmDb.delete(dirtyBeads).where(inArray(dirtyBeads.cell_id, cellIdList));
          await swarmDb.delete(beads).where(eq(beads.project_key, options.projectKey));
        }
      } else {
        // Clear all cell views using Drizzle
        await swarmDb.delete(beadComments);
        await swarmDb.delete(beadLabels);
        await swarmDb.delete(beadDependencies);
        await swarmDb.delete(blockedBeadsCache);
        await swarmDb.delete(dirtyBeads);
        await swarmDb.delete(beads);
      }
    }

    // Read all cell events
    const events = await readCellEventsDrizzle(swarmDb, {
      projectKey: options.projectKey,
      afterSequence: options.fromSequence,
    });

    // Replay each event through projections
    for (const event of events) {
      // Cast to any to match projections' loose event type
      await updateProjectionsDrizzle(swarmDb, event as any);
    }

    return {
      eventsReplayed: events.length,
      duration: Date.now() - startTime,
    };
  });
}
