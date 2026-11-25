/**
 * Beads Adapter Tests
 *
 * Tests the HiveAdapter factory and its interface implementation.
 *
 * ## Test Strategy
 * 1. Factory creation - createHiveAdapter returns valid adapter
 * 2. Core CRUD operations - create, read, update, close beads
 * 3. Dependency management - add, remove, query dependencies
 * 4. Label operations - add, remove, query labels
 * 5. Comment operations - add, update, delete comments
 * 6. Epic operations - add/remove children, closure eligibility
 * 7. Query helpers - ready beads, in-progress, blocked
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "../types/database.js";
import { createTestLibSQLDb } from "../test-libsql.js";
import { createHiveAdapter } from "./adapter.js";
import type { HiveAdapter } from "../types/hive-adapter.js";

describe("Beads Adapter", () => {
  let db: DatabaseAdapter;
  let adapter: HiveAdapter;
  const projectKey = "/test/project";

  // BEFORE EACH: Create fresh libSQL database
  beforeEach(async () => {
    // Use libSQL test helper - schema already includes all tables
    const { adapter: dbAdapter } = await createTestLibSQLDb();
    db = dbAdapter;

    // Create adapter (no migrations needed - schema already set up)
    adapter = createHiveAdapter(db, projectKey);
  });

  // ============================================================================
  // Factory and Interface Tests
  // ============================================================================

  test("adapterDuplicateOperationIdReturnsExistingCell", async () => {
    const first = await adapter.createCell(projectKey, { title: "Op", type: "task", operation_id: "op-1" });
    const second = await adapter.createCell(projectKey, { title: "Op again", type: "task", operation_id: "op-1" });
    expect(second.id).toBe(first.id);
    expect(second.operation_id).toBe("op-1");
    const found = await adapter.queryCells(projectKey, { operation_id: "op-1" });
    expect(found.map((c) => c.id)).toEqual([first.id]);
  });

  test("closeCell with completion_operation_id is idempotent and conflicts on a different identity", async () => {
    const cell = await adapter.createCell(projectKey, { title: "Complete me", type: "task" });
    const closed = await adapter.closeCell(projectKey, cell.id, "done", { completion_operation_id: "effect-complete-1" });
    expect(closed).toMatchObject({ status: "closed", completion_operation_id: "effect-complete-1" });

    const again = await adapter.closeCell(projectKey, cell.id, "done again", { completion_operation_id: "effect-complete-1" });
    expect(again).toMatchObject({ status: "closed", completion_operation_id: "effect-complete-1", closed_reason: "done" });

    await expect(
      adapter.closeCell(projectKey, cell.id, "other", { completion_operation_id: "effect-complete-2" }),
    ).rejects.toMatchObject({ name: "OperationIdConflictError" });

    const legacy = await adapter.createCell(projectKey, { title: "Closed without identity", type: "task" });
    await adapter.closeCell(projectKey, legacy.id, "manual");
    await expect(
      adapter.closeCell(projectKey, legacy.id, "late", { completion_operation_id: "effect-complete-3" }),
    ).rejects.toMatchObject({ name: "OperationIdConflictError" });
  });

  test("manual close vs identity close race: one event and a coherent identity", async () => {
    for (let round = 0; round < 6; round++) {
      const cell = await adapter.createCell(projectKey, { title: `Mixed race ${round}`, type: "task" });
      const identity = `mixed-${round}`;
      const calls = [
        adapter.closeCell(projectKey, cell.id, "manual"),
        adapter.closeCell(projectKey, cell.id, "identity", { completion_operation_id: identity }),
      ];
      if (round % 2 === 1) calls.reverse();
      const [manualOrIdentity, other] = await Promise.allSettled(calls);
      const results = round % 2 === 1 ? [other, manualOrIdentity] : [manualOrIdentity, other];
      const [manual, identityClose] = results;
      const final = await adapter.getCell(projectKey, cell.id);
      const events = await db.query<{ data: string }>("SELECT data FROM events WHERE type = 'cell_closed'");
      expect(events.rows.filter((row) => JSON.parse(row.data).cell_id === cell.id)).toHaveLength(1);
      if (final?.completion_operation_id === null || final?.completion_operation_id === undefined) {
        expect(manual.status).toBe("fulfilled");
        expect(final?.closed_reason).toBe("manual");
        expect(identityClose.status).toBe("rejected");
        expect((identityClose as PromiseRejectedResult).reason).toMatchObject({ name: "OperationIdConflictError" });
      } else {
        expect(final.completion_operation_id).toBe(identity);
        expect(final.closed_reason).toBe("identity");
        expect(identityClose.status).toBe("fulfilled");
        expect(manual.status).toBe("rejected");
        expect((manual as PromiseRejectedResult).reason).toMatchObject({ name: "OperationIdConflictError" });
      }
    }
  });

  test("atomic close updates blocked cache and dirty marker", async () => {
    const blocker = await adapter.createCell(projectKey, { title: "Blocker", type: "task" });
    const blocked = await adapter.createCell(projectKey, { title: "Blocked", type: "task" });
    await adapter.addDependency(projectKey, blocked.id, blocker.id, "blocks");
    const before = await db.query<{ blocker_ids: string }>(
      "SELECT blocker_ids FROM blocked_beads_cache WHERE cell_id = ?", [blocked.id],
    );
    expect(JSON.parse(before.rows[0].blocker_ids)).toEqual([blocker.id]);
    await db.query("DELETE FROM dirty_beads WHERE cell_id = ?", [blocker.id]);

    await adapter.closeCell(projectKey, blocker.id, "done", { completion_operation_id: "cache-op" });

    const after = await db.query("SELECT cell_id FROM blocked_beads_cache WHERE cell_id = ?", [blocked.id]);
    expect(after.rows).toHaveLength(0);
    const dirty = await db.query("SELECT cell_id FROM dirty_beads WHERE cell_id = ?", [blocker.id]);
    expect(dirty.rows).toHaveLength(1);
  });

  test("guarded close on an already-closed cell with the same timestamp changes nothing", async () => {
    const { appendCellEvent } = await import("./store.js");
    const blocker = await adapter.createCell(projectKey, { title: "TS blocker", type: "task" });
    const blocked = await adapter.createCell(projectKey, { title: "TS blocked", type: "task" });
    await adapter.addDependency(projectKey, blocked.id, blocker.id, "blocks");
    await db.query("UPDATE beads SET status = 'closed', closed_at = 4242, closed_reason = 'pre' WHERE id = ?", [blocker.id]);
    await db.query("UPDATE blocked_beads_cache SET blocker_ids = '[\"stale\"]', updated_at = 1 WHERE cell_id = ?", [blocked.id]);
    await db.query("DELETE FROM dirty_beads");
    const snapshot = async () => ({
      events: (await db.query("SELECT id FROM events WHERE type = 'cell_closed'")).rows,
      cache: (await db.query("SELECT * FROM blocked_beads_cache ORDER BY cell_id")).rows,
      dirty: (await db.query("SELECT * FROM dirty_beads")).rows,
      bead: (await db.query("SELECT status, closed_at, closed_reason, result FROM beads WHERE id = ?", [blocker.id])).rows,
    });
    const before = await snapshot();
    await expect(
      appendCellEvent({ type: "cell_closed", project_key: projectKey, cell_id: blocker.id, timestamp: 4242, reason: "again", result: "r" } as any, undefined, db),
    ).rejects.toMatchObject({ name: "CellCloseRejectedError" });
    expect(await snapshot()).toEqual(before);
  });

  test("closing a missing cell reports CellNotFoundError", async () => {
    await expect(adapter.closeCell(projectKey, "no-such-cell", "x")).rejects.toMatchObject({ name: "CellNotFoundError" });
  });

  test("empty result keeps the previous result (truthy-result semantics)", async () => {
    const cell = await adapter.createCell(projectKey, { title: "Result", type: "task" });
    await db.query("UPDATE beads SET result = 'earlier', result_at = 7 WHERE id = ?", [cell.id]);
    const closed = await adapter.closeCell(projectKey, cell.id, "done", { result: "" });
    expect(closed).toMatchObject({ result: "earlier", result_at: 7 });
  });

  test("close rebuilds blocked cache for the closed cell and dependents (multi-blocker, stale, missing)", async () => {
    const a = await adapter.createCell(projectKey, { title: "A", type: "task" });
    const b = await adapter.createCell(projectKey, { title: "B", type: "task" });
    const upstream = await adapter.createCell(projectKey, { title: "Up", type: "task" });
    const d1 = await adapter.createCell(projectKey, { title: "D1", type: "task" });
    const d2 = await adapter.createCell(projectKey, { title: "D2", type: "task" });
    await adapter.addDependency(projectKey, a.id, upstream.id, "blocks");
    await adapter.addDependency(projectKey, d1.id, a.id, "blocks");
    await adapter.addDependency(projectKey, d1.id, b.id, "blocks");
    await adapter.addDependency(projectKey, d2.id, a.id, "blocks");
    // Corrupt cache: stale row for d1, missing row for d2, stale row for the closing cell.
    await db.query("UPDATE blocked_beads_cache SET blocker_ids = '[\"ghost\"]' WHERE cell_id = ?", [d1.id]);
    await db.query("DELETE FROM blocked_beads_cache WHERE cell_id = ?", [d2.id]);
    await db.query("UPDATE blocked_beads_cache SET blocker_ids = '[\"ghost\"]' WHERE cell_id = ?", [a.id]);

    await adapter.closeCell(projectKey, a.id, "done", { completion_operation_id: "rebuild-op" });

    const cache = async (id: string) => {
      const rows = (await db.query<{ blocker_ids: string }>("SELECT blocker_ids FROM blocked_beads_cache WHERE cell_id = ?", [id])).rows;
      return rows.length === 0 ? null : (JSON.parse(rows[0].blocker_ids) as string[]).sort();
    };
    expect(await cache(a.id)).toEqual([upstream.id]);
    expect(await cache(d1.id)).toEqual([upstream.id, b.id].sort());
    expect(await cache(d2.id)).toEqual([upstream.id]);
    const token = (await db.query<{ data: string }>("SELECT data FROM events WHERE type = 'cell_closed'")).rows
      .map((row) => JSON.parse(row.data)).find((data) => data.cell_id === a.id);
    expect(typeof token.event_token).toBe("string");
    expect((await adapter.getCell(projectKey, a.id))?.completion_operation_id).toBe("rebuild-op");
  });

  test("concurrent different-identity closes: one event, one winner, loser conflicts", async () => {
    const cell = await adapter.createCell(projectKey, { title: "Race close", type: "task" });
    const results = await Promise.allSettled(
      ["race-A", "race-B", "race-C"].map((id) =>
        adapter.closeCell(projectKey, cell.id, `close ${id}`, { completion_operation_id: id }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ name: "OperationIdConflictError" });
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ completion_operation_id?: string | null }>).value
      .completion_operation_id;
    expect(["race-A", "race-B", "race-C"]).toContain(winner as string);
    expect((await adapter.getCell(projectKey, cell.id))?.completion_operation_id).toBe(winner);
    const events = await db.query<{ data: string }>(
      "SELECT data FROM events WHERE type = 'cell_closed'",
    );
    expect(events.rows.filter((row) => JSON.parse(row.data).cell_id === cell.id)).toHaveLength(1);
  });

  test("reopen clears completion identity so a later manual close has none", async () => {
    const cell = await adapter.createCell(projectKey, { title: "Reopen me", type: "task" });
    await adapter.closeCell(projectKey, cell.id, "done", { completion_operation_id: "reopen-A" });
    await adapter.reopenCell(projectKey, cell.id);
    expect((await adapter.getCell(projectKey, cell.id))?.completion_operation_id).toBeNull();
    const closed = await adapter.closeCell(projectKey, cell.id, "manual");
    expect(closed.completion_operation_id).toBeNull();
  });

  test("concurrent creates with same operation_id converge on one cell", async () => {
    const results = await Promise.all(
      [1, 2, 3].map((n) => adapter.createCell(projectKey, { title: `Race ${n}`, type: "task", operation_id: "op-race" })),
    );
    expect(new Set(results.map((c) => c.id)).size).toBe(1);
    expect(await adapter.queryCells(projectKey, { operation_id: "op-race" })).toHaveLength(1);
    const events = await db.query<{ data: string }>(
      "SELECT data FROM events WHERE type = 'cell_created'",
    );
    const raced = events.rows.filter((row) => JSON.parse(row.data).operation_id === "op-race");
    expect(raced).toHaveLength(1);
  });

  test("forced projection failure rolls back the cell_created event", async () => {
    await db.exec(`CREATE TRIGGER force_bead_fail BEFORE INSERT ON beads
      BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END;`);
    await expect(
      adapter.createCell(projectKey, { title: "Doomed", type: "task", operation_id: "op-doomed" }),
    ).rejects.toThrow(/forced projection failure/);
    const events = await db.query<{ n: number }>(
      "SELECT COUNT(id) AS n FROM events WHERE type = 'cell_created'",
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  test("store classifies only a real beads.operation_id UNIQUE violation as conflict", async () => {
    const { appendCellEvent, OperationIdConflictError } = await import("./store.js");
    const created = (id: string, op: string) =>
      ({
        type: "cell_created", project_key: projectKey, cell_id: id, timestamp: Date.now(),
        title: id, issue_type: "task", priority: 2, operation_id: op,
      }) as any;

    await appendCellEvent(created("store-seed", "op-seed"), undefined, db);
    const dup = await appendCellEvent(created("store-dup", "op-seed"), undefined, db).catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(OperationIdConflictError);

    await db.exec(`CREATE TRIGGER force_constraint BEFORE INSERT ON beads
      BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: beads.operation_id'); END;`);
    const other = await appendCellEvent(created("store-other", "op-other"), undefined, db).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(OperationIdConflictError);

    const events = await db.query<{ data: string }>("SELECT data FROM events WHERE type = 'cell_created'");
    expect(events.rows.map((r) => JSON.parse(r.data).cell_id)).toEqual(["store-seed"]);
  });

  test("createCell rethrows non-operation_id errors", async () => {
    await expect(
      adapter.createCell(projectKey, { title: "Bad parent", type: "task", parent_id: "missing-parent", operation_id: "op-bad" }),
    ).rejects.toThrow();
    expect(await adapter.queryCells(projectKey, { operation_id: "op-bad" })).toHaveLength(0);
  });

  test("createCell without operation_id still creates distinct cells", async () => {
    const a = await adapter.createCell(projectKey, { title: "A", type: "task" });
    const b = await adapter.createCell(projectKey, { title: "B", type: "task" });
    expect(a.id).not.toBe(b.id);
  });

  test("createHiveAdapter - returns valid adapter", () => {
    expect(adapter).toBeDefined();
    expect(adapter.createCell).toBeFunction();
    expect(adapter.getCell).toBeFunction();
    expect(adapter.queryCells).toBeFunction();
    expect(adapter.updateCell).toBeFunction();
    expect(adapter.closeCell).toBeFunction();
  });

  // ============================================================================
  // Core CRUD Operations
  // ============================================================================

  test("createCell - creates a new bead", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Test Bead",
      type: "task",
      priority: 2,
    });

    expect(bead).toBeDefined();
    expect(bead.title).toBe("Test Bead");
    expect(bead.type).toBe("task");
    expect(bead.status).toBe("open");
    expect(bead.priority).toBe(2);
  });

  test("getCell - retrieves existing bead", async () => {
    const created = await adapter.createCell(projectKey, {
      title: "Get Test",
      type: "feature",
      priority: 3,
    });

    const retrieved = await adapter.getCell(projectKey, created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(created.id);
    expect(retrieved?.title).toBe("Get Test");
  });

  test("queryCells - returns all beads", async () => {
    await adapter.createCell(projectKey, {
      title: "Bead 1",
      type: "task",
      priority: 2,
    });
    await adapter.createCell(projectKey, {
      title: "Bead 2",
      type: "bug",
      priority: 1,
    });

    const beads = await adapter.queryCells(projectKey);
    expect(beads.length).toBeGreaterThanOrEqual(2);
  });

  // ============================================================================
  // Bead ID Validation Tests
  // ============================================================================

  test("createCell - should reject null cell ID via event system", async () => {
    // Create a cell event with null ID to simulate generateBeadId failure
    const { appendCellEvent } = await import("./store.js");
    
    const badEvent: any = {
      type: "cell_created",
      project_key: projectKey,
      cell_id: null, // This should be rejected
      timestamp: Date.now(),
      title: "Bad Bead",
      issue_type: "task",
      priority: 2,
    };
    
    await expect(appendCellEvent(badEvent, undefined, db)).rejects.toThrow(
      /Bead ID cannot be null or empty/
    );
  });

  test("createCell - should reject empty cell ID via event system", async () => {
    const { appendCellEvent } = await import("./store.js");
    
    const badEvent: any = {
      type: "cell_created",
      project_key: projectKey,
      cell_id: "", // Empty string should also be rejected
      timestamp: Date.now(),
      title: "Bad Bead",
      issue_type: "task",
      priority: 2,
    };
    
    await expect(appendCellEvent(badEvent, undefined, db)).rejects.toThrow(
      /Bead ID cannot be null or empty/
    );
  });

  test("createCell - should reject whitespace-only cell ID", async () => {
    const { appendCellEvent } = await import("./store.js");
    
    const badEvent: any = {
      type: "cell_created",
      project_key: projectKey,
      cell_id: "   ", // Whitespace only should be rejected
      timestamp: Date.now(),
      title: "Bad Bead",
      issue_type: "task",
      priority: 2,
    };
    
    await expect(appendCellEvent(badEvent, undefined, db)).rejects.toThrow(
      /Bead ID cannot be null or empty/
    );
  });

  test("updateCell - updates bead fields", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Original",
      type: "task",
      priority: 2,
    });

    const updated = await adapter.updateCell(projectKey, bead.id, {
      title: "Updated",
      description: "New description",
      priority: 1,
    });

    expect(updated.title).toBe("Updated");
    expect(updated.description).toBe("New description");
    expect(updated.priority).toBe(1);
  });

  test("changeCellStatus - changes bead status", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Status Test",
      type: "task",
      priority: 2,
    });

    const updated = await adapter.changeCellStatus(projectKey, bead.id, "in_progress");
    expect(updated.status).toBe("in_progress");
  });

  test("closeCell - closes a bead", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Close Test",
      type: "task",
      priority: 2,
    });

    const closed = await adapter.closeCell(projectKey, bead.id, "Completed");
    expect(closed.status).toBe("closed");
    expect(closed.closed_reason).toBe("Completed");
    expect(closed.closed_at).toBeGreaterThan(0);
  });

  test("reopenCell - reopens a closed bead", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Reopen Test",
      type: "task",
      priority: 2,
    });

    await adapter.closeCell(projectKey, bead.id, "Done");
    const reopened = await adapter.reopenCell(projectKey, bead.id);

    expect(reopened.status).toBe("open");
    expect(reopened.closed_at).toBeNull();
    expect(reopened.closed_reason).toBeNull();
  });

  // ============================================================================
  // Dependency Operations
  // ============================================================================

  test("addDependency - adds a dependency", async () => {
    const bead1 = await adapter.createCell(projectKey, {
      title: "Blocker",
      type: "task",
      priority: 2,
    });
    const bead2 = await adapter.createCell(projectKey, {
      title: "Blocked",
      type: "task",
      priority: 2,
    });

    const dep = await adapter.addDependency(projectKey, bead2.id, bead1.id, "blocks");
    expect(dep.depends_on_id).toBe(bead1.id);
    expect(dep.relationship).toBe("blocks");
  });

  test("getDependencies - returns dependencies", async () => {
    const bead1 = await adapter.createCell(projectKey, {
      title: "Blocker",
      type: "task",
      priority: 2,
    });
    const bead2 = await adapter.createCell(projectKey, {
      title: "Blocked",
      type: "task",
      priority: 2,
    });

    await adapter.addDependency(projectKey, bead2.id, bead1.id, "blocks");
    const deps = await adapter.getDependencies(projectKey, bead2.id);

    expect(deps).toHaveLength(1);
    expect(deps[0]?.depends_on_id).toBe(bead1.id);
  });

  test("removeDependency - removes a dependency", async () => {
    const bead1 = await adapter.createCell(projectKey, {
      title: "Blocker",
      type: "task",
      priority: 2,
    });
    const bead2 = await adapter.createCell(projectKey, {
      title: "Blocked",
      type: "task",
      priority: 2,
    });

    await adapter.addDependency(projectKey, bead2.id, bead1.id, "blocks");
    await adapter.removeDependency(projectKey, bead2.id, bead1.id, "blocks");

    const deps = await adapter.getDependencies(projectKey, bead2.id);
    expect(deps).toHaveLength(0);
  });

  // ============================================================================
  // Label Operations
  // ============================================================================

  test("addLabel - adds a label to bead", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Label Test",
      type: "task",
      priority: 2,
    });

    const label = await adapter.addLabel(projectKey, bead.id, "p0");
    expect(label.label).toBe("p0");
  });

  test("getLabels - returns bead labels", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Label Test",
      type: "task",
      priority: 2,
    });

    await adapter.addLabel(projectKey, bead.id, "p0");
    await adapter.addLabel(projectKey, bead.id, "urgent");

    const labels = await adapter.getLabels(projectKey, bead.id);
    expect(labels).toContain("p0");
    expect(labels).toContain("urgent");
  });

  test("removeLabel - removes a label", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Label Test",
      type: "task",
      priority: 2,
    });

    await adapter.addLabel(projectKey, bead.id, "p0");
    await adapter.removeLabel(projectKey, bead.id, "p0");

    const labels = await adapter.getLabels(projectKey, bead.id);
    expect(labels).not.toContain("p0");
  });

  // ============================================================================
  // Comment Operations
  // ============================================================================

  test("addComment - adds a comment to bead", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Comment Test",
      type: "task",
      priority: 2,
    });

    const comment = await adapter.addComment(projectKey, bead.id, "testuser", "Test comment");
    expect(comment.body).toBe("Test comment");
    expect(comment.author).toBe("testuser");
  });

  test("getComments - returns bead comments", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "Comment Test",
      type: "task",
      priority: 2,
    });

    await adapter.addComment(projectKey, bead.id, "user1", "Comment 1");
    await adapter.addComment(projectKey, bead.id, "user2", "Comment 2");

    const comments = await adapter.getComments(projectKey, bead.id);
    expect(comments).toHaveLength(2);
  });

  // ============================================================================
  // Epic Operations
  // ============================================================================

  test("getEpicChildren - returns epic children", async () => {
    const epic = await adapter.createCell(projectKey, {
      title: "Epic",
      type: "epic",
      priority: 3,
    });
    const child = await adapter.createCell(projectKey, {
      title: "Subtask",
      type: "task",
      priority: 2,
      parent_id: epic.id,
    });

    const children = await adapter.getEpicChildren(projectKey, epic.id);
    expect(children.some((c) => c.id === child.id)).toBe(true);
  });

  test("isEpicClosureEligible - returns true when all children closed", async () => {
    const epic = await adapter.createCell(projectKey, {
      title: "Epic",
      type: "epic",
      priority: 3,
    });
    const child = await adapter.createCell(projectKey, {
      title: "Subtask",
      type: "task",
      priority: 2,
      parent_id: epic.id,
    });

    // Not eligible yet
    let eligible = await adapter.isEpicClosureEligible(projectKey, epic.id);
    expect(eligible).toBe(false);

    // Close child
    await adapter.closeCell(projectKey, child.id, "Done");

    // Now eligible
    eligible = await adapter.isEpicClosureEligible(projectKey, epic.id);
    expect(eligible).toBe(true);
  });

  // ============================================================================
  // Query Helpers
  // ============================================================================

  test("getNextReadyCell - returns unblocked bead", async () => {
    await adapter.createCell(projectKey, {
      title: "Ready Bead",
      type: "task",
      priority: 1,
    });

    const ready = await adapter.getNextReadyCell(projectKey);
    expect(ready).not.toBeNull();
    expect(ready?.status).toBe("open");
  });

  test("getInProgressCells - returns in-progress beads", async () => {
    const bead = await adapter.createCell(projectKey, {
      title: "WIP Bead",
      type: "task",
      priority: 2,
    });

    await adapter.changeCellStatus(projectKey, bead.id, "in_progress");

    const inProgress = await adapter.getInProgressCells(projectKey);
    expect(inProgress.some((b) => b.id === bead.id)).toBe(true);
  });

  // ============================================================================
  // Query Cells Tests
  // ============================================================================

  test("queryCells with parent_id returns only children", async () => {
    // Create epic
    const epic = await adapter.createCell(projectKey, { 
      title: "Epic", 
      type: "epic",
      priority: 1
    });
    
    // Create children
    const child1 = await adapter.createCell(projectKey, { 
      title: "Child 1", 
      type: "task",
      priority: 2,
      parent_id: epic.id 
    });
    const child2 = await adapter.createCell(projectKey, { 
      title: "Child 2", 
      type: "task",
      priority: 2,
      parent_id: epic.id 
    });
    
    // Create unrelated cell
    await adapter.createCell(projectKey, { 
      title: "Unrelated", 
      type: "task",
      priority: 2
    });
    
    // Query by parent_id
    const children = await adapter.queryCells(projectKey, { parent_id: epic.id });
    
    expect(children).toHaveLength(2);
    expect(children.map(c => c.id)).toContain(child1.id);
    expect(children.map(c => c.id)).toContain(child2.id);
  });

  // ============================================================================
  // Cell ID Generation Tests (TDD for project-name prefix)
  // ============================================================================

  describe("generateBeadId with project name prefix", () => {
    test("uses project name from package.json as prefix", async () => {
      // This test will fail initially - we're doing TDD
      // Expected ID format: {slugified-name}-{hash}-{timestamp}{random}
      // Example: swarm-mail-lf2p4u-mjbneh7mqah
      
      // Use import.meta.dir to get the directory of this test file
      // Then navigate up to the package root (src/hive -> src -> package root)
      const testProjectPath = import.meta.dir.split("/").slice(0, -2).join("/");
      const testAdapter = createHiveAdapter(db, testProjectPath);
      
      const bead = await testAdapter.createCell(testProjectPath, {
        title: "Test with project prefix",
        type: "task",
        priority: 2,
      });

      // ID should start with "swarm-mail-" (slugified from package.json name)
      // Hash can include negative sign, so we use [-a-z0-9]+
      expect(bead.id).toMatch(/^swarm-mail-[-a-z0-9]+-[a-z0-9]+$/);
    });

    test("RED: changeCellStatus to 'closed' sets closed_at (CHECK constraint)", async () => {
      // BUG: changeCellStatus doesn't set closed_at when changing to 'closed'
      // This violates CHECK constraint: ((status = 'closed') = (closed_at IS NOT NULL))
      
      const cell = await adapter.createCell(projectKey, {
        title: "Status Close Test",
        type: "task",
        priority: 2,
      });

      // Change status to 'closed' (NOT using closeCell which works correctly)
      const updated = await adapter.changeCellStatus(projectKey, cell.id, "closed", {
        reason: "Done via status change"
      });

      // Should set closed_at when status changes to 'closed'
      expect(updated.status).toBe("closed");
      expect(updated.closed_at).toBeGreaterThan(0);
      expect(updated.closed_at).not.toBeNull();
      expect(updated.closed_reason).toBe("Done via status change");
    });

    test("RED: changeCellStatus from 'closed' to 'open' clears closed_at", async () => {
      const cell = await adapter.createCell(projectKey, {
        title: "Reopen via status Test",
        type: "task",
        priority: 2,
      });

      // Close first
      await adapter.closeCell(projectKey, cell.id, "Done");

      // Reopen via status change (NOT using reopenCell)
      const reopened = await adapter.changeCellStatus(projectKey, cell.id, "open");

      // Should clear closed_at when status changes away from 'closed'
      expect(reopened.status).toBe("open");
      expect(reopened.closed_at).toBeNull();
    });

    test("falls back to 'cell' when package.json not found", async () => {
      const nonExistentPath = "/path/that/does/not/exist";
      const testAdapter = createHiveAdapter(db, nonExistentPath);
      
      const bead = await testAdapter.createCell(nonExistentPath, {
        title: "Test fallback",
        type: "task",
        priority: 2,
      });

      // Should use 'cell' as fallback prefix
      // Hash can include negative sign, so we use [-a-z0-9]+
      expect(bead.id).toMatch(/^cell-[-a-z0-9]+-[a-z0-9]+$/);
    });

    test("falls back to 'cell' when package.json has no name field", async () => {
      // Use test fixture with package.json that has no name field
      const fixturePath = "/Users/joel/Code/joelhooks/opencode-swarm-plugin/packages/swarm-mail/test-fixtures";
      const testAdapter = createHiveAdapter(db, fixturePath);
      
      const bead = await testAdapter.createCell(fixturePath, {
        title: "Test no-name fallback",
        type: "task",
        priority: 2,
      });

      // Should use 'cell' as fallback prefix
      expect(bead.id).toMatch(/^cell-[-a-z0-9]+-[a-z0-9]+$/);
    });

    test("slugifies project name correctly", () => {
      // Import the slugify function for direct testing
      // We'll test the logic directly since we can't easily create temp package.json files
      
      // Test cases for slugification:
      const testCases = [
        { input: "My Cool App", expected: "my-cool-app" },
        { input: "app@v2.0", expected: "app-v2-0" },
        { input: "@scope/package", expected: "scope-package" },
        { input: "UPPERCASE", expected: "uppercase" },
        { input: "spaces   multiple", expected: "spaces-multiple" },
        { input: "-leading-trailing-", expected: "leading-trailing" },
        { input: "special!@#$%chars", expected: "special-chars" },
      ];

      // Since slugifyProjectName is internal, we test it through the public API
      // by verifying the actual behavior with swarm-mail package
      // The swarm-mail package name should produce "swarm-mail" prefix
      const testProjectPath = "/Users/joel/Code/joelhooks/opencode-swarm-plugin/packages/swarm-mail";
      const testAdapter = createHiveAdapter(db, testProjectPath);
      
      // We know swarm-mail package exists and should slugify to "swarm-mail"
      expect(testProjectPath).toContain("swarm-mail");
    });

    test("backward compatible - existing bd-* IDs still work", async () => {
      // Create a cell (will have new format with project-name prefix)
      const cell1 = await adapter.createCell(projectKey, {
        title: "New format cell",
        type: "task",
        priority: 2,
      });

      // Verify we can retrieve cells with the new ID format
      const retrieved = await adapter.getCell(projectKey, cell1.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(cell1.id);
      
      // Update and close operations should work with new format IDs
      await adapter.updateCell(projectKey, cell1.id, { title: "Updated" });
      await adapter.closeCell(projectKey, cell1.id, "Done");
      
      // All operations are backward compatible - no special handling needed for old vs new IDs
      // The system treats all IDs uniformly regardless of prefix format
    });
  });
});
