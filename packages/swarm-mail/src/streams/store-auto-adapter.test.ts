/**
 * Test auto-adapter resolution (the fix for removing getDatabase() requirement)
 *
 * This test verifies that store functions work WITHOUT passing explicit dbOverride.
 * This was the bug: functions threw "dbOverride parameter is required" error.
 */
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createEvent } from "./events";
import { appendEvent, closeAndClearAdapterCache, getOrCreateAdapter } from "./store";
import { createTestDatabasePath, removeTestDatabasePath } from "../test-utils/test-db.js";

describe("Store Auto-Adapter Resolution", () => {
  let testDbPath: string;
  let previousDbPath: string | undefined;

  beforeAll(async () => {
    previousDbPath = process.env.SWARM_DB_PATH;
    testDbPath = await createTestDatabasePath("swarm-store-adapter-test");
    process.env.SWARM_DB_PATH = testDbPath;
  });

  afterEach(async () => {
    await closeAndClearAdapterCache();
    await removeTestDatabasePath(testDbPath);
  });

  afterAll(async () => {
    await closeAndClearAdapterCache();
    await removeTestDatabasePath(testDbPath);
    await rm(dirname(testDbPath), { recursive: true, force: true });
    if (previousDbPath === undefined) delete process.env.SWARM_DB_PATH;
    else process.env.SWARM_DB_PATH = previousDbPath;
  });

  it("appendEvent works WITHOUT explicit dbOverride", async () => {
    const event = createEvent("agent_registered", {
      project_key: "test-project",
      agent_name: "TestAgent",
      program: "opencode",
      model: "claude-sonnet-4",
    });

    // This was throwing before the fix:
    // "dbOverride parameter is required for this function"
    const result = await appendEvent(event, "/tmp/test");

    expect(result.id).toBeDefined();
    expect(result.sequence).toBeDefined();
    expect(result.type).toBe("agent_registered");
  });

  it("second call reuses cached adapter", async () => {
    const event1 = createEvent("agent_registered", {
      project_key: "test-project",
      agent_name: "Agent1",
      program: "opencode",
      model: "claude-sonnet-4",
    });

    const event2 = createEvent("agent_registered", {
      project_key: "test-project",
      agent_name: "Agent2",
      program: "opencode",
      model: "claude-sonnet-4",
    });

    // Both calls use same adapter (cached)
    const result1 = await appendEvent(event1, "/tmp/test");
    const result2 = await appendEvent(event2, "/tmp/test");

    // Sequence should increment (proving same DB)
    expect(result2.sequence).toBe(result1.sequence + 1);
  });

  it("closes cached adapters before clearing the cache", async () => {
    const first = await getOrCreateAdapter();
    await closeAndClearAdapterCache();

    await expect(first.query("SELECT 1")).rejects.toThrow(/closed|CLOSED/i);

    const second = await getOrCreateAdapter();
    expect(second).not.toBe(first);
  });
});
