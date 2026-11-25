/**
 * Task 13d3b: the default plugin setup enables the WorkUnit lifecycle.
 *
 * Breaks caught: setup staying on the legacy store, migration running after
 * recovery/tools, non-idempotent re-setup, tests opening the global DB, the
 * explicit legacy override being ignored, and a bundle that cannot load swarm-mail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

  test("runtime.store is the WorkUnit adapter: set_budget routes natively and never writes legacy KV", async () => {
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
    // The migrated s1 mission is still OPEN: native set_budget refuses it as a conflict
    // (never runtime_unavailable) and writes neither SQL nor legacy KV.
    await expect(
      budget!.execute({ mode: "audit" }, { sessionID: "s1", agent: "swarm/swarm-coordinator", messageID: "m", id: "call-1" }),
    ).rejects.toThrow("[conflict]");
    for (const name of ["swarm_mission_status", "swarm_agent_audit"]) {
      const tool = editor.list().find((entry) => entry.name === name);
      await expect(tool!.execute({}, { sessionID: "s1", agent: "swarm/swarm-coordinator", messageID: "m", id: `call-${name}` }))
        .resolves.toBeDefined();
    }
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

  test("packed plugin + CLI bundles resolve swarm-mail from an isolated consumer outside the workspace", async () => {
    const pkg = join(import.meta.dir, "..");
    const mailPkg = join(pkg, "..", "swarm-mail");
    await mkdir("/tmp/opencode", { recursive: true });
    const root = await mkdtemp("/tmp/opencode/swarmx-consumer-");
    const run = (cmd: string[], cwd: string) => {
      const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, SWARM_DB_PATH: ":memory:" } });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    try {
      expect(run(["bun", "run", "build"], pkg).code).toBe(0);
      expect(run(["bun", "pm", "pack", "--destination", root, "--quiet"], mailPkg).code).toBe(0);
      expect(run(["bun", "pm", "pack", "--destination", root, "--quiet"], pkg).code).toBe(0);
      const tarballs = (await readdir(root)).filter((f) => f.endsWith(".tgz"));
      const mailTgz = tarballs.find((f) => f.startsWith("swarm-mail-"));
      const swarmxTgz = tarballs.find((f) => f.startsWith("benjamin-swarmx-"));
      expect(mailTgz).toBeDefined();
      expect(swarmxTgz).toBeDefined();
      const consumer = join(root, "consumer");
      await mkdir(join(consumer, "node_modules", "@opencode"), { recursive: true });
      await writeFile(join(consumer, "package.json"), JSON.stringify({
        name: "swarmx-consumer", private: true, type: "module",
        dependencies: { "@benjamin/swarmx": `file:../${swarmxTgz}`, "swarm-mail": `file:../${mailTgz}` },
        overrides: { "swarm-mail": `file:../${mailTgz}` },
      }));
      const install = run(["bun", "install", "--production", "--omit=peer"], consumer);
      expect(install.code).toBe(0);
      // @opencode/plugin is a host-provided peer (OpenCode supplies it); link the workspace copy.
      await symlink(await realpath(join(pkg, "node_modules", "@opencode", "plugin")), join(consumer, "node_modules", "@opencode", "plugin"));
      const installed = join(consumer, "node_modules", "@benjamin", "swarmx");
      expect(await realpath(installed)).not.toContain(join(pkg, ".."));

      const plugin = run(["node", "--input-type=module", "-e",
        `const m = await import("@benjamin/swarmx"); const mail = await import("swarm-mail"); console.log(typeof m.default?.setup, typeof m.setupWorkUnitRuntime, typeof mail.getSwarmMailDatabaseAdapter);`,
      ], consumer);
      expect(plugin.err).toBe("");
      expect(plugin.out.trim()).toBe("function function function");

      const cli = run(["node", join(installed, "dist", "bin", "swarmx.js"), "doctor", "--target", join(root, "target"), "--json"], consumer);
      const report = JSON.parse(cli.out) as { command?: string; error?: string };
      expect(report.error).toBeUndefined();
      expect(report.command).toBe("doctor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("default setup: SQL build lock through shell hooks", () => {
  type Hook = (event: unknown) => Promise<void>;
  async function rig(): Promise<{ db: DatabaseAdapter; before: (id: string) => Promise<void>; after: (id: string) => Promise<void> }> {
    const db = await freshDb();
    const ctx = createFakeContext({ projectId: `${P}-lock`, storage: [] });
    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    const beforeHook = ctx.captures.toolHooks.get("execute.before")?.[0] as Hook | undefined;
    const afterHook = ctx.captures.toolHooks.get("execute.after")?.[0] as Hook | undefined;
    expect(beforeHook).toBeDefined();
    expect(afterHook).toBeDefined();
    const shell = (id: string) => ({
      tool: "shell", sessionID: "ses-lock", agent: "build", messageID: `msg-${id}`, id, input: { command: "bun run build" },
    });
    return {
      db,
      before: (id) => beforeHook!(shell(id)),
      after: (id) => afterHook!({ ...shell(id), status: "completed", result: { output: "ok" } }),
    };
  }
  const lockTokens = async (db: DatabaseAdapter): Promise<string[]> =>
    (await db.query<{ token: string }>("SELECT token FROM swarmx_locks")).rows.map((row) => String(row.token));
  const BUSY = "another build/test is already running";

  test("a concurrent build is refused while the SQL lock is held", async () => {
    const r = await rig();
    await r.before("call-a");
    expect(await lockTokens(r.db)).toEqual(["call-a"]);
    await expect(r.before("call-b")).rejects.toThrow(BUSY);
  });

  test("release from a different callID is a no-op", async () => {
    const r = await rig();
    await r.before("call-a");
    await r.after("call-b");
    expect(await lockTokens(r.db)).toEqual(["call-a"]);
    await expect(r.before("call-b")).rejects.toThrow(BUSY);
  });

  test("acquire succeeds after the owner releases", async () => {
    const r = await rig();
    await r.before("call-a");
    await r.after("call-a");
    expect(await lockTokens(r.db)).toEqual([]);
    await r.before("call-b");
    expect(await lockTokens(r.db)).toEqual(["call-b"]);
    await r.after("call-b");
    expect(await lockTokens(r.db)).toEqual([]);
  });

  test("a stale lock left by a missed release is reclaimed", async () => {
    const r = await rig();
    await r.before("call-a");
    // call-a never reaches execute.after; age its lock past the 15-minute stale window.
    await r.db.query("UPDATE swarmx_locks SET acquired_at = ?", [Date.now() - 16 * 60 * 1000]);
    await r.before("call-b");
    expect(await lockTokens(r.db)).toEqual(["call-b"]);
    // The late release of the reclaimed owner must not drop the new holder's lock.
    await r.after("call-a");
    expect(await lockTokens(r.db)).toEqual(["call-b"]);
  });
});
