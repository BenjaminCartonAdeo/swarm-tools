/**
 * Task 13d3b: the default plugin setup enables the WorkUnit lifecycle.
 *
 * Breaks caught: setup staying on the legacy store, migration running after
 * recovery/tools, non-idempotent re-setup, tests opening the global DB, the
 * explicit legacy override being ignored, and a bundle that cannot load swarm-mail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { createLibSQLAdapter, getSwarmMailDatabaseAdapter, type DatabaseAdapter } from "swarm-mail";
import { createSwarmxPlugin } from "../src/index";
import { createFakeContext } from "./helpers";

const P = "proj-default-setup";
const T0 = "2026-01-01T00:00:00.000Z";

function legacyMission(sessionID: string): readonly [string, unknown] {
  return [`mission:${P}:${sessionID}`, {
    missionID: `m-${sessionID}`,
    projectID: P,
    sessionID,
    active: true,
    mode: "dev",
    budget: { maxSpawns: 7, maxIterations: 2 },
    counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
    createdAt: T0,
    updatedAt: T0,
  }];
}

const opened: DatabaseAdapter[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

async function freshDb(): Promise<DatabaseAdapter> {
  const db = await createLibSQLAdapter({ url: ":memory:" });
  opened.push(db);
  return db;
}

async function count(db: DatabaseAdapter, sql: string): Promise<number> {
  const result = await db.query(sql);
  return Number((result.rows[0] as { n: unknown }).n);
}

describe("default setup: WorkUnit lifecycle", () => {
  test("tests resolve the canonical accessor in memory and default setup builds the schema there", async () => {
    expect(process.env.SWARM_DB_PATH).toBe(":memory:");
    const ctx = createFakeContext({ projectId: `${P}-canonical`, storage: [] });
    await createSwarmxPlugin().setup(ctx as unknown as Plugin.Context);
    const db = await getSwarmMailDatabaseAdapter();
    expect(await count(db, "SELECT COUNT(name) AS n FROM sqlite_master WHERE name = 'swarmx_missions'")).toBe(1);
  });

  test("migration precedes recovery, adapter, runtime and tool registration; legacy session is tombstoned", async () => {
    const db = await freshDb();
    const steps: string[] = [];
    const ctx = createFakeContext({ projectId: P, storage: [legacyMission("s1")] });
    const realTransform = ctx.tool.transform.bind(ctx.tool);
    (ctx.tool as { transform: typeof realTransform }).transform = (callback) => {
      steps.push("tools");
      return realTransform(callback);
    };
    await createSwarmxPlugin({ workUnitDatabase: async () => db, workUnitTrace: (s) => steps.push(s) })
      .setup(ctx as unknown as Plugin.Context);
    expect(steps).toEqual(["host", "schema", "migration", "recovery", "adapter", "commands", "runtime", "tools"]);
    expect(await count(db, `SELECT COUNT(id) AS n FROM swarmx_missions WHERE project = '${P}'`)).toBe(1);
    expect([...ctx.storage.map.keys()].filter((k) => k.startsWith("legacy-tombstone:"))).toHaveLength(1);
  });

  test("repeated setup over the same DB and storage is idempotent", async () => {
    const db = await freshDb();
    const storage = [legacyMission("s1"), legacyMission("s2")] as const;
    const ctx = createFakeContext({ projectId: P, storage });
    for (let i = 0; i < 3; i += 1) {
      await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    }
    expect(await count(db, `SELECT COUNT(id) AS n FROM swarmx_missions WHERE project = '${P}'`)).toBe(2);
    expect([...ctx.storage.map.keys()].filter((k) => k.startsWith("legacy-tombstone:"))).toHaveLength(1);
  });

  test("runtime.store is the WorkUnit adapter: legacy-only tools fail typed and never write legacy KV", async () => {
    const db = await freshDb();
    const ctx = createFakeContext({
      projectId: P,
      storage: [legacyMission("s1")],
      agents: [{ id: "swarm/swarm-coordinator", name: "swarm-coordinator", mode: "primary", hidden: false, permissions: [] }],
    });
    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    const editor = ctx.createEditor();
    ctx.captures.toolTransforms[0]?.(editor);
    const budget = editor.list().find((tool) => tool.name === "swarm_set_budget");
    expect(budget).toBeDefined();
    const legacyBefore = JSON.stringify(ctx.storage.map.get(`mission:${P}:s1`));
    // swarm_set_budget is still legacy-store-only (native routing lands later): with the WorkUnit
    // adapter installed as runtime.store it must fail typed instead of writing legacy KV.
    await expect(
      budget!.execute({ mode: "audit" }, { sessionID: "s1", agent: "swarm/swarm-coordinator", messageID: "m", id: "call-1" }),
    ).rejects.toThrow("runtime_unavailable");
    const after = await db.query(`SELECT mode FROM swarmx_missions WHERE project = '${P}'`);
    expect((after.rows[0] as { mode: unknown }).mode).toBe("dev");
    expect(JSON.stringify(ctx.storage.map.get(`mission:${P}:s1`))).toBe(legacyBefore);
  });

  test("explicit legacy override keeps the legacy backend: no migration, no tombstone", async () => {
    const db = await freshDb();
    const ctx = createFakeContext({ projectId: P, storage: [legacyMission("s1")] });
    await createSwarmxPlugin({ workUnitDatabase: async () => db, runtime: { workUnit: undefined } })
      .setup(ctx as unknown as Plugin.Context);
    expect(await count(db, "SELECT COUNT(name) AS n FROM sqlite_master WHERE name = 'swarmx_missions'")).toBe(0);
    expect([...ctx.storage.map.keys()].filter((k) => k.startsWith("legacy-tombstone:"))).toEqual([]);
  });

  test("built bundle imports and resolves swarm-mail at runtime", async () => {
    const pkg = join(import.meta.dir, "..");
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: pkg, stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode).toBe(0);
    const probe = Bun.spawnSync(["bun", "-e",
      `const m = await import(${JSON.stringify(join(pkg, "dist/index.js"))}); console.log(typeof m.default?.setup, typeof m.setupWorkUnitRuntime);`,
    ], { cwd: pkg, stdout: "pipe", stderr: "pipe", env: { ...process.env, SWARM_DB_PATH: ":memory:" } });
    expect(probe.stderr.toString()).toBe("");
    expect(probe.stdout.toString().trim()).toBe("function function");
  }, 60_000);
});
