/**
 * Hive Migrations Tests
 *
 * Tests for schema migrations including:
 * - Fresh database initialization
 * - Upgrade from beads → cells rename
 * - Recovery from corrupted/partial migrations
 *
 * @module hive/migrations.test
 */

import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { describe, expect, test, beforeEach } from "bun:test";
import type { DatabaseAdapter } from "../types/database.js";
import { convertPlaceholders } from "../libsql.js";
import { beadsMigration, cellsViewMigrationLibSQL, hiveMigrationsLibSQL } from "./migrations.js";

function wrapLibSQL(client: Client): DatabaseAdapter {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const converted = convertPlaceholders(sql, params);
      const result = await client.execute({
        sql: converted.sql,
        args: converted.params,
      });
      return { rows: result.rows as T[] };
    },
    exec: async (sql: string) => {
      const converted = convertPlaceholders(sql);
      // LibSQL's execute() doesn't support multiple statements
      // Use executeMultiple() which handles BEGIN...END blocks correctly
      await client.executeMultiple(converted.sql);
    },
    close: () => client.close(),
  };
}

describe("Hive Migrations", () => {
  let client: Client;
  let db: DatabaseAdapter;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    db = wrapLibSQL(client);

    // Create base schema (events table, schema_version) - minimal setup for migrations
    await client.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence INTEGER,
        type TEXT NOT NULL,
        project_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT
      )
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      )
    `);
  });

  describe("beadsMigration (v6)", () => {
    test("creates beads table with correct schema", async () => {
      await db.exec(beadsMigration.up);

      // Verify table exists (SQLite uses sqlite_master instead of information_schema)
      const result = await db.query<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='beads'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe("beads");
    });

    test("creates all supporting tables", async () => {
      await db.exec(beadsMigration.up);

      const tables = ["beads", "bead_dependencies", "bead_labels", "bead_comments", "blocked_beads_cache", "dirty_beads"];

      for (const table of tables) {
        const result = await db.query<{ name: string }>(`
          SELECT name FROM sqlite_master WHERE type='table' AND name = '${table}'
        `);
        expect(result.rows.length).toBe(1);
      }
    });
  });

  describe("cellsViewMigration (v7)", () => {
    test("creates cells view pointing to beads table", async () => {
      // First apply v6
      await db.exec(beadsMigration.up);

      // Then apply v7
      await db.exec(cellsViewMigrationLibSQL.up);

      // Verify view exists (SQLite uses sqlite_master for views too)
      const result = await db.query<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='view' AND name='cells'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe("cells");
    });

    test("cells view allows SELECT queries", async () => {
      await db.exec(beadsMigration.up);
      await db.exec(cellsViewMigrationLibSQL.up);

      // Insert into beads
      await db.query(`
        INSERT INTO beads (id, project_key, type, status, title, priority, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, ["bd-test", "/test", "task", "open", "Test task", 2, Date.now(), Date.now()]);

      // Query via cells view
      const result = await db.query<{ id: string; title: string }>(`
        SELECT id, title FROM cells WHERE project_key = $1
      `, ["/test"]);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe("bd-test");
      expect(result.rows[0].title).toBe("Test task");
    });

    test("cells view allows INSERT via INSTEAD OF trigger", async () => {
      await db.exec(beadsMigration.up);
      await db.exec(cellsViewMigrationLibSQL.up);

      // Insert via cells view
      await db.query(`
        INSERT INTO cells (id, project_key, type, status, title, priority, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, ["bd-via-view", "/test", "bug", "open", "Via view", 1, Date.now(), Date.now()]);

      // Verify it's in beads table
      const result = await db.query<{ id: string }>(`
        SELECT id FROM beads WHERE id = $1
      `, ["bd-via-view"]);

      expect(result.rows).toHaveLength(1);
    });
  });

  describe("upgrade path", () => {
    test("existing v6 database can upgrade to v7", async () => {
      // Simulate existing v6 database with data
      await db.exec(beadsMigration.up);
      await db.query(`
        INSERT INTO schema_version (version, applied_at, description)
        VALUES ($1, $2, $3)
      `, [6, Date.now(), beadsMigration.description]);

      await db.query(`
        INSERT INTO beads (id, project_key, type, status, title, priority, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, ["bd-existing", "/test", "task", "open", "Existing task", 2, Date.now(), Date.now()]);

      // Apply v7 migration
      await db.exec(cellsViewMigrationLibSQL.up);
      await db.query(`
        INSERT INTO schema_version (version, applied_at, description)
        VALUES ($1, $2, $3)
      `, [7, Date.now(), cellsViewMigrationLibSQL.description]);

      // Verify existing data accessible via cells view
      const result = await db.query<{ id: string }>(`
        SELECT id FROM cells WHERE id = $1
      `, ["bd-existing"]);

      expect(result.rows).toHaveLength(1);
    });

    test("fresh database gets both v6 and v7", async () => {
      // Apply all migrations
      for (const migration of hiveMigrationsLibSQL) {
        await db.exec(migration.up);
        await db.query(`
          INSERT INTO schema_version (version, applied_at, description)
          VALUES ($1, $2, $3)
        `, [migration.version, Date.now(), migration.description]);
      }

      // Verify both beads table and cells view exist
      const beadsExists = await db.query<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='beads'
      `);
      const cellsExists = await db.query<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='view' AND name='cells'
      `);

      expect(beadsExists.rows.length).toBe(1);
      expect(cellsExists.rows.length).toBe(1);
    });

    test("migrationV11AddsNullableUniqueOperationId", async () => {
      expect(hiveMigrationsLibSQL.map(({ version }) => version)).toEqual([7, 8, 9, 10, 11]);

      for (const migration of hiveMigrationsLibSQL) {
        await db.exec(migration.up);
      }

      const columns = await db.query<{ name: string; notnull: number }>("PRAGMA table_info(beads)");
      expect(columns.rows.map(({ name }) => name)).toEqual([
        "id", "project_key", "type", "status", "title", "description", "priority", "parent_id",
        "assignee", "created_at", "updated_at", "closed_at", "closed_reason", "deleted_at",
        "deleted_by", "delete_reason", "created_by", "result", "result_at", "operation_id",
      ]);
      expect(columns.rows.find(({ name }) => name === "operation_id")?.notnull).toBe(0);

      const indexes = await db.query<{ name: string; sql: string }>(`
        SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_beads_operation_id'
      `);
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0].sql).toContain("WHERE operation_id IS NOT NULL");
    });

    test("oldReaderCanReadMigratedCells", async () => {
      for (const migration of hiveMigrationsLibSQL.filter(({ version }) => version <= 10)) {
        await db.exec(migration.up);
      }
      await db.query(`
        INSERT INTO beads (id, project_key, type, status, title, priority, created_at, updated_at)
        VALUES ('old-reader-cell', '/test', 'task', 'open', 'Old reader', 2, 100, 100)
      `);
      const migration = hiveMigrationsLibSQL.find(({ version }) => version === 11);
      expect(migration).toBeDefined();
      if (!migration) return;
      await db.exec(migration.up);

      const oldReaderColumns = await db.query<{ id: string; title: string; result: string | null }>(`
        SELECT id, title, result FROM cells WHERE id = 'old-reader-cell'
      `);
      expect(oldReaderColumns.rows).toEqual([{ id: "old-reader-cell", title: "Old reader", result: null }]);
      const viewColumns = await db.query<{ name: string }>("PRAGMA table_info(cells)");
      expect(viewColumns.rows.map(({ name }) => name)).toEqual([
        "id", "project_key", "type", "status", "title", "description", "priority", "parent_id",
        "assignee", "created_at", "updated_at", "closed_at", "closed_reason", "deleted_at",
        "deleted_by", "delete_reason", "created_by", "result", "result_at", "operation_id",
      ]);
    });

    test("rawDuplicateOperationIdIsRejected", async () => {
      for (const migration of hiveMigrationsLibSQL) {
        await db.exec(migration.up);
      }

      const insert = `INSERT INTO beads (id, project_key, type, status, title, priority, created_at, updated_at, operation_id)
        VALUES (?, '/test', 'task', 'open', ?, 2, 100, 100, 'operation-unique')`;
      await client.execute({ sql: insert, args: ["cell-one", "First"] });
      await expect(client.execute({ sql: insert, args: ["cell-two", "Second"] })).rejects.toThrow();
    });

    test("rollbackV11RestoresV10Schema", async () => {
      for (const migration of hiveMigrationsLibSQL.filter(({ version }) => version <= 10)) {
        await db.exec(migration.up);
      }
      const v10Columns = await db.query<{ name: string }>("PRAGMA table_info(beads)");
      const v10ViewColumns = await db.query<{ name: string }>("PRAGMA table_info(cells)");
      const v10Triggers = await db.query<{ name: string; sql: string }>(`
        SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('cells_insert', 'cells_update') ORDER BY name
      `);
      const migration = hiveMigrationsLibSQL.find(({ version }) => version === 11);
      expect(migration).toBeDefined();
      if (!migration) return;

      await db.exec(migration.up);
      await db.exec(migration.down);

      const restoredColumns = await db.query<{ name: string }>("PRAGMA table_info(beads)");
      const restoredViewColumns = await db.query<{ name: string }>("PRAGMA table_info(cells)");
      const restoredTriggers = await db.query<{ name: string; sql: string }>(`
        SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('cells_insert', 'cells_update') ORDER BY name
      `);
      expect(restoredColumns.rows.map(({ name }) => name)).toEqual(v10Columns.rows.map(({ name }) => name));
      expect(restoredViewColumns.rows.map(({ name }) => name)).toEqual(v10ViewColumns.rows.map(({ name }) => name));
      expect(restoredTriggers.rows).toEqual(v10Triggers.rows);
      const index = await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_beads_operation_id'");
      expect(index.rows).toHaveLength(0);
    });
  });

  describe("recovery scenarios", () => {
    test("handles missing cells view gracefully", async () => {
      // Database has v6 but somehow missing v7
      await db.exec(beadsMigration.up);

      // Query cells should fail
      await expect(
        db.query(`SELECT * FROM cells LIMIT 1`)
      ).rejects.toThrow();

      // After applying v7, it should work
      await db.exec(cellsViewMigrationLibSQL.up);

      const result = await db.query(`SELECT * FROM cells LIMIT 1`);
      expect(result.rows).toHaveLength(0); // Empty but works
    });
  });
});
