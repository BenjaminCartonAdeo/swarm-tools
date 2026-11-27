import { describe, expect, it } from "vitest";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertSafeTestDatabasePath,
  createTestDatabasePath,
  GLOBAL_DATABASE_PATH,
  removeTestDatabasePath,
} from "./test-db";

describe("test database path safety", () => {
  it("rejects the real global database path", () => {
    expect(() => assertSafeTestDatabasePath(GLOBAL_DATABASE_PATH)).toThrow(/global database/i);
  });

  it("accepts an isolated temporary database path", () => {
    expect(() => assertSafeTestDatabasePath("/tmp/swarm-test-isolated/swarm.db")).not.toThrow();
  });

  it("rejects a symlink to the real global database", async () => {
    const path = await createTestDatabasePath("swarm-test-symlink");
    const link = join(dirname(path), "global-link.db");
    await symlink(GLOBAL_DATABASE_PATH, link);
    try {
      expect(() => assertSafeTestDatabasePath(link)).toThrow(/global database/i);
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });

  it("creates a database path outside the global location", async () => {
    const path = await createTestDatabasePath("swarm-test-helper");
    try {
      expect(path).not.toBe(GLOBAL_DATABASE_PATH);
      expect(() => assertSafeTestDatabasePath(path)).not.toThrow();
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });

  it("removes only the test database and its sidecars", async () => {
    const path = await createTestDatabasePath("swarm-test-cleanup");
    await mkdir(dirname(path), { recursive: true });
    await Promise.all([
      writeFile(path, "db"),
      writeFile(`${path}-wal`, "wal"),
      writeFile(`${path}-shm`, "shm"),
    ]);
    await removeTestDatabasePath(path);
    await expect(access(path)).rejects.toThrow();
    await expect(access(`${path}-wal`)).rejects.toThrow();
    await expect(access(`${path}-shm`)).rejects.toThrow();
    await rm(dirname(path), { recursive: true, force: true });
  });
});
