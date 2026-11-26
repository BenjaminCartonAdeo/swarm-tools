/**
 * Tests for streams/index.ts exports
 * 
 * This file tests that the module exports the correct libSQL/Drizzle functions
 * and utilities, with no PGLite references.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabasePath, removeTestDatabasePath } from "../test-utils/test-db.js";

let testDbPath: string;
let previousDbPath: string | undefined;

beforeAll(async () => {
  previousDbPath = process.env.SWARM_DB_PATH;
  testDbPath = await createTestDatabasePath("swarm-index-test");
  process.env.SWARM_DB_PATH = testDbPath;
});

afterAll(async () => {
  await removeTestDatabasePath(testDbPath);
  await rm(dirname(testDbPath), { recursive: true, force: true });
  if (previousDbPath === undefined) delete process.env.SWARM_DB_PATH;
  else process.env.SWARM_DB_PATH = previousDbPath;
});

describe("streams/index.ts module", () => {
  const indexPath = join(__dirname, "index.ts");
  const content = readFileSync(indexPath, "utf-8");

  it("exports utility functions (withTimeout, withTiming, getDatabasePath)", () => {
    // Import them to verify they exist
    import("./index").then((mod) => {
      expect(mod.withTimeout).toBeDefined();
      expect(mod.withTiming).toBeDefined();
      expect(mod.getDatabasePath).toBeDefined();
    });
  });

  it("exports Drizzle store functions", () => {
    import("./index").then((mod) => {
      expect(mod.appendEvent).toBeDefined();
      expect(mod.readEvents).toBeDefined();
      expect(mod.getLatestSequence).toBeDefined();
    });
  });

  it("exports Drizzle projection functions", () => {
    import("./index").then((mod) => {
      expect(mod.getAgents).toBeDefined();
      expect(mod.getAgent).toBeDefined();
      expect(mod.getInbox).toBeDefined();
      expect(mod.getMessage).toBeDefined();
      expect(mod.getThreadMessages).toBeDefined();
      expect(mod.getActiveReservations).toBeDefined();
      expect(mod.checkConflicts).toBeDefined();
      expect(mod.getEvalRecords).toBeDefined();
      expect(mod.getEvalStats).toBeDefined();
    });
  });

  it("has no PGlite imports (case-insensitive)", () => {
    const hasPGliteImport = /import.*["'].*pglite/i.test(content);
    expect(hasPGliteImport).toBe(false);
  });

  it("has no getDatabase() function definition", () => {
    const hasGetDatabase = /export\s+(async\s+)?function\s+getDatabase\s*\(/.test(content);
    expect(hasGetDatabase).toBe(false);
  });

  it("has no initializeSchema() function definition", () => {
    const hasInitSchema = /export\s+(async\s+)?function\s+initializeSchema/.test(content);
    expect(hasInitSchema).toBe(false);
  });

  it("has no closeDatabase() function definition", () => {
    const hasCloseDb = /export\s+(async\s+)?function\s+closeDatabase/.test(content);
    expect(hasCloseDb).toBe(false);
  });

  it("has getDatabasePath() function (libSQL utility, not PGLite)", () => {
    const hasGetDbPath = /export\s+function\s+getDatabasePath/.test(content);
    expect(hasGetDbPath).toBe(true);
  });

  it("has getOldProjectDbPaths() function for migration detection", () => {
    const hasGetOldPaths = /export\s+function\s+getOldProjectDbPaths/.test(content);
    expect(hasGetOldPaths).toBe(true);
  });
});

describe("getDatabasePath()", () => {
  it("returns the configured test path when no projectPath is provided", async () => {
    const { getDatabasePath } = await import("./index");
    expect(getDatabasePath()).toBe(testDbPath);
  });
  
  it("returns the configured test path even when projectPath is provided", async () => {
    const { getDatabasePath } = await import("./index");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    
    const projectPath = join(tmpdir(), "test-project-" + Date.now());
    const result = getDatabasePath(projectPath);
    expect(result).toBe(testDbPath);
  });
  
  it("returns the configured test path for worktree paths", async () => {
    const { getDatabasePath } = await import("./index");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    
    const projectPath = join(tmpdir(), "test-project-worktree-" + Date.now());
    const result = getDatabasePath(projectPath);
    expect(result).toBe(testDbPath);
  });
});

describe("getOldProjectDbPaths()", () => {
  it("returns paths to check for migration", async () => {
    const { getOldProjectDbPaths } = await import("./index");
    const { join } = await import("node:path");
    
    const projectPath = "/some/project";
    const paths = getOldProjectDbPaths(projectPath);
    
    expect(paths).toEqual({
      libsql: join(projectPath, ".opencode", "streams.db"),
      pglite: join(projectPath, ".opencode", "streams"),
    });
  });
});

describe("getDatabasePath() auto-migration", () => {
  it("triggers migration when local DB exists", async () => {
    const { getDatabasePath } = await import("./index");
    const { createClient } = await import("@libsql/client");
    const { existsSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    
    // Create temp project with real SQLite DB
    const projectPath = join(tmpdir(), `test-auto-migrate-${Date.now()}`);
    const localDbDir = join(projectPath, ".opencode");
    const localDbPath = join(localDbDir, "streams.db");
    const expectedDbPath = testDbPath;
    
    try {
      mkdirSync(localDbDir, { recursive: true });
      
      // Create a real SQLite database with a table
      const localDb = createClient({ url: `file:${localDbPath}` });
      await localDb.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)");
      await localDb.execute("INSERT INTO events (id) VALUES ('test-event')");
      localDb.close();
      
      // Call getDatabasePath - triggers migration in background
      const result = getDatabasePath(projectPath);
      
      // Should return global path immediately
      expect(result).toBe(expectedDbPath);
      
      // Wait for migration to complete (fire-and-forget)
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Local DB should be renamed to .migrated
      expect(existsSync(localDbPath)).toBe(false);
      expect(existsSync(`${localDbPath}.migrated`)).toBe(true);
    } finally {
      // Cleanup
      if (existsSync(projectPath)) {
        rmSync(projectPath, { recursive: true, force: true });
      }
    }
  });
  
  it("does not trigger migration when local DB does not exist", async () => {
    const { getDatabasePath } = await import("./index");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    
    // Create temp project WITHOUT local DB
    const projectPath = join(tmpdir(), `test-no-migrate-${Date.now()}`);
    
    // Call getDatabasePath - should NOT trigger migration (no local DB)
    const result = getDatabasePath(projectPath);
    
    // Should return the configured test path
    expect(result).toBe(testDbPath);
  });
  
  it("only migrates once (idempotent)", async () => {
    const { getDatabasePath } = await import("./index");
    const { createClient } = await import("@libsql/client");
    const { existsSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    
    // Create temp project with real SQLite DB
    const projectPath = join(tmpdir(), `test-idempotent-${Date.now()}`);
    const localDbDir = join(projectPath, ".opencode");
    const localDbPath = join(localDbDir, "streams.db");
    const expectedDbPath = testDbPath;
    
    try {
      mkdirSync(localDbDir, { recursive: true });
      
      // Create a real SQLite database
      const localDb = createClient({ url: `file:${localDbPath}` });
      await localDb.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)");
      await localDb.execute("INSERT INTO events (id) VALUES ('test-event-2')");
      localDb.close();
      
      // First call - triggers migration
      getDatabasePath(projectPath);
      
      // Wait for migration to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // .migrated marker should exist
      expect(existsSync(`${localDbPath}.migrated`)).toBe(true);
      
      // Second call - should NOT re-migrate (idempotent check)
      const result = getDatabasePath(projectPath);
      
      // Should still return global path
      expect(result).toBe(expectedDbPath);
      
      // Wait a bit to ensure no second migration happened
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // .migrated file should still exist (not duplicated)
      expect(existsSync(`${localDbPath}.migrated`)).toBe(true);
    } finally {
      // Cleanup
      if (existsSync(projectPath)) {
        rmSync(projectPath, { recursive: true, force: true });
      }
    }
  });
});
