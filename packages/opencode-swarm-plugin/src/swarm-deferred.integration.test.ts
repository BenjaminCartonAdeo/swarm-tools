/**
 * Swarm DurableDeferred Integration Tests
 *
 * Tests cross-agent task completion signaling using DurableDeferred.
 * Workers resolve a deferred when completing, coordinators await it.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, pipe } from "effect";
import type { DatabaseAdapter } from "../../swarm-mail/src/types/database";
import type { SwarmMailAdapter } from "../../swarm-mail/src/adapter";
import type { HiveAdapter } from "../../swarm-mail/src/hive/adapter";
import { closeAllSwarmMailLibSQL, getSwarmMailLibSQL } from "../../swarm-mail/src/libsql.convenience";
import { createHiveAdapter } from "../../swarm-mail/src/hive/adapter";
import { DurableDeferred, DurableDeferredLive } from "../../swarm-mail/src/streams/effect/deferred";
import { swarm_complete } from "./swarm-orchestrate";
import { getHiveAdapter } from "./hive";
import { resetToolCache } from "./tool-availability";

describe("swarm_complete DurableDeferred integration", () => {
  let swarmMail: SwarmMailAdapter;
  let hive: HiveAdapter;
  let db: DatabaseAdapter;
  let projectKey: string;
  let beadId: string;
  let testDirectory: string;
  let previousDbPath: string | undefined;

  beforeAll(async () => {
    previousDbPath = process.env.SWARM_DB_PATH;
    testDirectory = await mkdtemp(join(tmpdir(), "swarm-deferred-test-"));
    process.env.SWARM_DB_PATH = join(testDirectory, "swarm.db");
    projectKey = "/tmp/test-deferred-integration";

    swarmMail = await getSwarmMailLibSQL(projectKey);
    db = await swarmMail.getDatabase();
    hive = createHiveAdapter(db, projectKey);
    await hive.runMigrations();

    await swarmMail.registerAgent(projectKey, "TestWorker");
    const cell = await hive.createCell(projectKey, {
      title: "Test Task",
      type: "task",
      priority: 2,
      status: "in_progress",
    });
    beadId = cell.id;
  });

  afterAll(async () => {
    await closeAllSwarmMailLibSQL();
    if (previousDbPath === undefined) delete process.env.SWARM_DB_PATH;
    else process.env.SWARM_DB_PATH = previousDbPath;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("completes quietly when deferred and hivemind are unavailable", async () => {
    await db.exec("DROP TABLE IF EXISTS deferred");
    const cell = await hive.createCell(projectKey, {
      title: "No optional capabilities",
      type: "task",
      priority: 2,
      status: "in_progress",
    });

    const binDir = await mkdtemp(join(tmpdir(), "swarm-no-hivemind-"));
    const marker = join(binDir, "hivemind-called");
    await writeFile(
      join(binDir, "hivemind"),
      `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`,
      { mode: 0o755 },
    );
    await writeFile(join(binDir, "semantic-memory"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const command of ["which", "git"]) {
      const resolved = Bun.which(command);
      if (resolved) await symlink(resolved, join(binDir, command));
    }
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    resetToolCache();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = JSON.parse(await swarm_complete.execute({
        project_key: projectKey,
        agent_name: "TestWorker",
        bead_id: cell.id,
        summary: "Completed without optional capabilities",
        start_time: Date.now() - 1000,
        skip_verification: true,
        skip_review: true,
      }, {
        sessionID: "test-session-no-optional",
        messageID: "test-message-no-optional",
        agent: "test-agent",
        abort: new AbortController().signal,
      }));

      expect(result.success).toBe(true);
      expect(result.deferred_resolved).toBe(false);
      expect(result.deferred_error).toBeUndefined();
      expect(await Bun.file(marker).exists()).toBe(false);
      const warnings = warnSpy.mock.calls.map((call) => call.join(" "));
      expect(warnings.some((warning) => warning.includes("deferred"))).toBe(false);
      expect(warnings.some((warning) => warning.includes("hivemind"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
      process.env.PATH = originalPath;
      resetToolCache();
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("surfaces real deferred failures when the table exists", async () => {
    await db.exec("DROP TABLE IF EXISTS deferred");
    await db.exec("CREATE TABLE deferred (url TEXT)");
    const cell = await hive.createCell(projectKey, {
      title: "Broken deferred schema",
      type: "task",
      priority: 2,
      status: "in_progress",
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = JSON.parse(await swarm_complete.execute({
        project_key: projectKey,
        agent_name: "TestWorker",
        bead_id: cell.id,
        summary: "Completed with a broken deferred table",
        start_time: Date.now() - 1000,
        skip_verification: true,
        skip_review: true,
      }, {
        sessionID: "test-session-broken-deferred",
        messageID: "test-message-broken-deferred",
        agent: "test-agent",
        abort: new AbortController().signal,
      }));

      expect(result.success).toBe(true);
      expect(result.deferred_resolved).toBe(false);
      expect(result.deferred_error).toContain("resolved");
      expect(warnSpy.mock.calls.some((call) => call.join(" ").includes("deferred"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await db.exec("DROP TABLE IF EXISTS deferred");
    }
  });

  it("should resolve deferred when swarm_complete is called", async () => {
    expect(await hive.getCell(projectKey, beadId)).not.toBeNull();
    expect(await (await getHiveAdapter(projectKey)).getCell(projectKey, beadId)).not.toBeNull();

    // First create deferred (coordinator side)
    const createProgram = Effect.gen(function* () {
      const service = yield* DurableDeferred;
      
      // Create deferred keyed by bead_id
      const handle = yield* service.create({
        ttlSeconds: 60,
        db,
        key: beadId,
      });

      expect(handle.url).toMatch(/^deferred:/);
      
      return handle.url;
    });

    const deferredUrl = await Effect.runPromise(
      pipe(createProgram, Effect.provide(DurableDeferredLive))
    );

    // Worker completes the task (this should resolve the deferred)
    const mockContext = {
      sessionID: "test-session",
      messageID: "test-message",
      agent: "test-agent",
      abort: new AbortController().signal,
    };

    const completeResult = await swarm_complete.execute(
      {
        project_key: projectKey,
        agent_name: "TestWorker",
        bead_id: beadId,
        summary: "Task completed successfully",
        start_time: Date.now() - 1500,
        skip_verification: true,
        skip_review: true,
      },
      mockContext
    );

    const parsed = JSON.parse(completeResult);
    expect(parsed.success).toBe(true);
    expect(parsed.closed).toBe(true);

    // Coordinator awaits the real completion signal written by swarm_complete.
    const awaitProgram = Effect.gen(function* () {
      const service = yield* DurableDeferred;
      const result = yield* service.await(deferredUrl, 5, db);
      return result;
    });

    const result = await Effect.runPromise(
      pipe(awaitProgram, Effect.provide(DurableDeferredLive))
    );

    expect(result).toEqual({ completed: true, summary: "Task completed successfully" });
  });

  it("should timeout if deferred is never resolved", async () => {
    const program = Effect.gen(function* () {
      const service = yield* DurableDeferred;
      
      // Create deferred with short timeout
      const handle = yield* service.create({
        ttlSeconds: 1,
        db,
      });

      // Don't resolve it - just await
      const result = yield* handle.value;
      
      return result;
    });

    // Should timeout and throw TimeoutError
    await expect(
      Effect.runPromise(
        pipe(program, Effect.provide(DurableDeferredLive))
      )
    ).rejects.toThrow(/timed out/);
  });
});
