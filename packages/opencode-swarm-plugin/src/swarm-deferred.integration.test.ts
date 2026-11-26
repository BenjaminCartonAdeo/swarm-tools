/**
 * Swarm DurableDeferred Integration Tests
 *
 * Tests cross-agent task completion signaling using DurableDeferred.
 * Workers resolve a deferred when completing, coordinators await it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, pipe } from "effect";
import type { DatabaseAdapter } from "../../swarm-mail/src/types/database";
import type { SwarmMailAdapter } from "../../swarm-mail/src/adapter";
import type { HiveAdapter } from "../../swarm-mail/src/hive/adapter";
import { closeAllSwarmMailLibSQL, getSwarmMailLibSQL } from "../../swarm-mail/src/libsql.convenience";
import { createHiveAdapter } from "../../swarm-mail/src/hive/adapter";
import { DurableDeferred, DurableDeferredLive } from "../../swarm-mail/src/streams/effect/deferred";
import { swarm_complete } from "./swarm-orchestrate";
import { getHiveAdapter } from "./hive";

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
