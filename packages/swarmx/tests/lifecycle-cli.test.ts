/**
 * Task 16: CLI-only lifecycle recovery, unit revoke and guarded downgrade.
 *
 * Subprocess tests run `bin/swarmx.ts` against a unique file DB under
 * /tmp/opencode with an isolated HOME; direct store tests use in-memory adapters.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";
import {
  claimReviewFeedback,
  createLibSQLAdapter,
  createLibSQLStreamsSchema,
  type DatabaseAdapter,
} from "swarm-mail";
import { createSwarmxPlugin, setupWorkUnitRuntime } from "../src/index";
import { ensureWorkUnitSchema } from "../src/workunit/schema";
import { getOrCreateHostInstanceId, requestDowngrade } from "../src/workunit/store";
import { acquireWorkUnitLock, cleanupLockName } from "../src/workunit/locks";
import { createFakeContext } from "./helpers";

const BIN = fileURLToPath(new URL("../bin/swarmx.ts", import.meta.url));
const HOST = osHostname();
const DEAD_PID = 999_999_999;
const P = "proj-a";
const Q = "proj-b";

interface Sandbox {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: DatabaseAdapter;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sandbox(): Promise<Sandbox> {
  mkdirSync("/tmp/opencode", { recursive: true });
  const dir = mkdtempSync("/tmp/opencode/swarmx-lifecycle-cli-");
  const dbPath = join(dir, "swarm.db");
  const db = await createLibSQLAdapter({ url: `file:${dbPath}` });
  await createLibSQLStreamsSchema(db);
  await ensureWorkUnitSchema(db);
  cleanups.push(async () => {
    try {
      await db.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, dbPath, db };
}

function cli(box: Sandbox, ...args: string[]): { code: number; json: any; stdout: string } {
  const home = join(box.dir, "home");
  mkdirSync(home, { recursive: true });
  const run = spawnSync("bun", [BIN, ...args], {
    env: { ...process.env, HOME: home, SWARM_DB_PATH: box.dbPath },
    encoding: "utf8",
  });
  let json: any;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    json = undefined;
  }
  return { code: run.status ?? -1, json, stdout: run.stdout };
}

async function seedMission(db: DatabaseAdapter, project: string, id: string, state = "OPEN"): Promise<void> {
  await db.query(
    "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0)",
    [id, project, `ses-${id}`, `m-${id}`, state],
  );
}

async function seedUnit(db: DatabaseAdapter, project: string, missionPk: string, id: string, state: string, fence = 3): Promise<void> {
  await db.query(
    "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0)",
    [id, project, missionPk, `call-${id}`, `idem-${id}`, state, fence],
  );
}

/** In-flight mandatory effect claimed by (instance, hostname, pid). */
async function seedClaimedEffect(
  db: DatabaseAdapter,
  project: string,
  effectId: string,
  claim: { instance: string; hostname: string; pid: number; token?: string },
): Promise<void> {
  const mission = `mission-${effectId}`;
  const unit = `unit-${effectId}`;
  await seedMission(db, project, mission);
  await seedUnit(db, project, mission, unit, "PUBLISHING");
  await db.query(
    `INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, operation_id, unit_fence, state, attempt, claim_token,
       host_instance_id, claimed_hostname, claimed_by_pid, claimed_at, updated_at)
     VALUES (?, ?, 'backend_complete', 1, ?, 3, 'in_flight', 1, ?, ?, ?, ?, 0, 0)`,
    [effectId, unit, `op-${effectId}`, claim.token ?? `tok-${effectId}`, claim.instance, claim.hostname, claim.pid],
  );
}

async function effectRow(db: DatabaseAdapter, effectId: string): Promise<Record<string, unknown>> {
  return (await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effectId])).rows[0] as Record<string, unknown>;
}

async function seedFeedbackClaim(db: DatabaseAdapter, operationId: string, project: string, hostname: string, pid: number) {
  const claim = await claimReviewFeedback({
    operationId,
    projectKey: project,
    taskId: `task-${operationId}`,
    workerId: "w",
    requestHash: "h",
    status: "approved",
    hostInstanceId: "any",
    hostname,
    pid,
  }, db);
  expect(claim.kind).toBe("claimed");
}

async function feedbackToken(db: DatabaseAdapter, operationId: string): Promise<unknown> {
  const row = (await db.query("SELECT claim_token FROM review_feedback_operations WHERE operation_id = ?", [operationId])).rows[0];
  return (row as { claim_token: unknown }).claim_token;
}

describe("swarmx recover", () => {
  // Break: recovery that skips dead same-host mandatory effects or does not report them.
  test("recoverListsUnknownAndMandatoryEffects", async () => {
    const box = await sandbox();
    const instance = await getOrCreateHostInstanceId(box.db, HOST);
    await seedClaimedEffect(box.db, P, "eff-dead", { instance, hostname: HOST, pid: DEAD_PID });

    const out = cli(box, "recover", "--json");

    expect(out.code).toBe(0);
    expect(out.json).toEqual({
      recoveredEffects: ["eff-dead"],
      recoveredFeedback: [],
      foreignHostEffects: [],
      foreignHostFeedback: [],
    });
    expect(await effectRow(box.db, "eff-dead")).toMatchObject({ state: "unknown", claim_token: null, claimed_by_pid: null });
  });

  // Break: a recover that kills or releases live foreign-host claims.
  test("recoverDoesNotAutoKillLiveForeignHost", async () => {
    const box = await sandbox();
    const child = spawn("sleep", ["30"]);
    try {
      await seedClaimedEffect(box.db, P, "eff-foreign", { instance: "other-instance", hostname: "other-host", pid: child.pid! });
      await seedFeedbackClaim(box.db, "op-foreign", P, "other-host", child.pid!);

      const out = cli(box, "recover", "--json");

      expect(out.code).toBe(0);
      expect(out.json.foreignHostEffects).toEqual(["eff-foreign"]);
      expect(out.json.foreignHostFeedback).toEqual(["op-foreign"]);
      expect(out.json.recoveredEffects).toEqual([]);
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await effectRow(box.db, "eff-foreign")).toMatchObject({ state: "in_flight", claim_token: "tok-eff-foreign" });
      expect(await feedbackToken(box.db, "op-foreign")).not.toBeNull();
    } finally {
      child.kill();
    }
  });

  // Break: foreign-host effect never recoverable, or recovered without naming it explicitly.
  test("recoverEffectRequiresExplicitId", async () => {
    const box = await sandbox();
    await seedClaimedEffect(box.db, P, "eff-a", { instance: "other", hostname: "other-host", pid: 1 });
    await seedClaimedEffect(box.db, P, "eff-b", { instance: "other", hostname: "other-host", pid: 1 });

    const out = cli(box, "recover", "--effect", "eff-a", "--json");

    expect(out.code).toBe(0);
    expect(out.json.explicitEffect).toBe("eff-a");
    expect(await effectRow(box.db, "eff-a")).toMatchObject({ state: "unknown", claim_token: null, host_instance_id: null });
    expect(await effectRow(box.db, "eff-b")).toMatchObject({ state: "in_flight" });

    const missing = cli(box, "recover", "--effect", "nope", "--json");
    expect(missing.code).toBe(1);
    expect(missing.json.error.code).toBe("not_found");
  });

  // Break: same-host dead feedback claims left stuck.
  test("recoverRecoversStaleFeedbackClaims", async () => {
    const box = await sandbox();
    await seedFeedbackClaim(box.db, "op-dead", P, HOST, DEAD_PID);

    const out = cli(box, "recover", "--json");

    expect(out.code).toBe(0);
    expect(out.json.recoveredFeedback).toEqual(["op-dead"]);
    expect(await feedbackToken(box.db, "op-dead")).toBeNull();
  });

  // Break: foreign feedback auto-released, or explicit --feedback not releasing it.
  test("recoverFeedbackRequiresExplicitIdForForeignHost", async () => {
    const box = await sandbox();
    await seedFeedbackClaim(box.db, "op-far", P, "other-host", DEAD_PID);

    const stale = cli(box, "recover", "--json");
    expect(stale.json.foreignHostFeedback).toEqual(["op-far"]);
    expect(await feedbackToken(box.db, "op-far")).not.toBeNull();

    const out = cli(box, "recover", "--feedback", "op-far", "--json");
    expect(out.code).toBe(0);
    expect(out.json.explicitFeedback).toBe("op-far");
    expect(await feedbackToken(box.db, "op-far")).toBeNull();
  });

  // Break: --project ignored by stale or explicit recovery.
  test("recoverProjectFilterDoesNotTouchOtherProjects", async () => {
    const box = await sandbox();
    const instance = await getOrCreateHostInstanceId(box.db, HOST);
    await seedClaimedEffect(box.db, P, "eff-p", { instance, hostname: HOST, pid: DEAD_PID });
    await seedClaimedEffect(box.db, Q, "eff-q", { instance, hostname: HOST, pid: DEAD_PID });
    await seedFeedbackClaim(box.db, "op-p", P, HOST, DEAD_PID);
    await seedFeedbackClaim(box.db, "op-q", Q, HOST, DEAD_PID);

    const out = cli(box, "recover", "--project", P, "--json");

    expect(out.code).toBe(0);
    expect(out.json.recoveredEffects).toEqual(["eff-p"]);
    expect(out.json.recoveredFeedback).toEqual(["op-p"]);
    expect(await effectRow(box.db, "eff-q")).toMatchObject({ state: "in_flight" });
    expect(await feedbackToken(box.db, "op-q")).not.toBeNull();

    const cross = cli(box, "recover", "--project", P, "--effect", "eff-q", "--json");
    expect(cross.code).toBe(1);
    expect(cross.json.error.code).toBe("not_found");
    expect(await effectRow(box.db, "eff-q")).toMatchObject({ state: "in_flight" });
  });

  // Break: CLI minting a random host id, which would turn own dead claims into "foreign".
  test("recoveryReusesPersistedHostIdentity", async () => {
    const box = await sandbox();
    await box.db.query(
      "INSERT INTO swarmx_host_identities (hostname, host_instance_id, created_at) VALUES (?, 'persisted-instance', 0)",
      [HOST],
    );
    await seedClaimedEffect(box.db, P, "eff-own", { instance: "persisted-instance", hostname: HOST, pid: DEAD_PID });

    const out = cli(box, "recover", "--json");
    expect(out.json.recoveredEffects).toEqual(["eff-own"]);

    // Plugin setup resolves the same persisted identity (no new row).
    const runtime = await setupWorkUnitRuntime(box.db, { projectID: P });
    expect(runtime.host.hostInstanceId).toBe("persisted-instance");
    expect(runtime.host.hostname).toBe(HOST);
    const row = (await box.db.query("SELECT COUNT(hostname) AS n FROM swarmx_host_identities")).rows[0] as { n: unknown };
    expect(Number(row.n)).toBe(1);
  });
});

describe("swarmx unit revoke", () => {
  // Break: revoke without a fence/reason, or ignoring a stale fence.
  test("unitRevokeRequiresExpectedFenceAndReason", async () => {
    const box = await sandbox();
    await seedMission(box.db, P, "m1");
    await seedUnit(box.db, P, "m1", "u1", "BOUND", 4);

    expect(cli(box, "unit", "revoke", "u1", "--reason", "x", "--json").code).toBe(2);
    const blank = cli(box, "unit", "revoke", "u1", "--expected-fence", "4", "--reason", "  ", "--json");
    expect(blank.code).toBe(2);
    expect(blank.json.error.code).toBe("usage_error");

    const stale = cli(box, "unit", "revoke", "u1", "--expected-fence", "3", "--reason", "stuck", "--json");
    expect(stale.code).toBe(1);
    expect(stale.json.error.code).toBe("fence_conflict");

    const ok = cli(box, "unit", "revoke", "u1", "--expected-fence", "4", "--reason", "stuck", "--json");
    expect(ok.code).toBe(0);
    expect(ok.json).toEqual({ unitId: "u1", state: "REVOKED", fence: 5, reason: "stuck" });

    const missing = cli(box, "unit", "revoke", "nope", "--expected-fence", "1", "--reason", "r", "--json");
    expect(missing.code).toBe(1);
    expect(missing.json.error.code).toBe("not_found");
  });
});

describe("swarmx downgrade", () => {
  // Break: downgrade request accepted while a mission is live.
  test("downgradeRefusesLiveMission", async () => {
    const box = await sandbox();
    await seedMission(box.db, P, "live", "CLOSING");

    const out = cli(box, "downgrade", "--project", P, "--yes", "--json");

    expect(out.code).toBe(1);
    expect(out.json.error.code).toBe("live_mission");
    const rows = (await box.db.query("SELECT COUNT(project) AS n FROM swarmx_downgrade_requests")).rows[0] as { n: unknown };
    expect(Number(rows.n)).toBe(0);
  });

  // Break: request not durable/idempotent, or empty project refused.
  test("downgradePersistsRetryableRequest", async () => {
    const box = await sandbox();
    await seedMission(box.db, P, "done", "FINISHED");

    expect(cli(box, "downgrade", "--project", P, "--json").code).toBe(2);
    const first = cli(box, "downgrade", "--project", P, "--yes", "--json");
    const second = cli(box, "downgrade", "--project", P, "--yes", "--json");
    const empty = cli(box, "downgrade", "--project", "empty-project", "--yes", "--json");

    expect(first).toMatchObject({ code: 0, json: { project: P, status: "requested" } });
    expect(second).toMatchObject({ code: 0, json: { project: P, status: "requested" } });
    expect(empty).toMatchObject({ code: 0, json: { project: "empty-project", status: "requested" } });
    const rows = (await box.db.query("SELECT project, status FROM swarmx_downgrade_requests ORDER BY project")).rows;
    expect(rows.map((r) => ({ ...(r as object) }))).toEqual([
      { project: "empty-project", status: "pending" },
      { project: P, status: "pending" },
    ]);
  });

  // Break: CLI downgrade touching WorkUnit/Hive data.
  test("downgradeLeavesDatabaseUntouched", async () => {
    const box = await sandbox();
    await seedMission(box.db, P, "m1", "FINISHED");
    await seedUnit(box.db, P, "m1", "u1", "DONE");
    const before = (await box.db.query("SELECT * FROM swarmx_work_units")).rows;

    cli(box, "downgrade", "--project", P, "--yes", "--json");

    const ctx = createFakeContext({ projectId: P, storage: [[`mission:${P}:s1`, { x: 1 }]] });
    await createSwarmxPlugin({ workUnitDatabase: async () => box.db }).setup(ctx as unknown as Plugin.Context);
    expect((await box.db.query("SELECT * FROM swarmx_work_units")).rows).toEqual(before);
    const missions = (await box.db.query("SELECT id, state FROM swarmx_missions")).rows;
    expect(missions.map((r) => ({ ...(r as object) }))).toEqual([{ id: "m1", state: "FINISHED" }]);
  });
});

describe("plugin downgrade consumer", () => {
  const storage = (): (readonly [string, unknown])[] => [
    [`mission:${P}:s1`, { stale: true }],
    [`budget:${P}:s1`, { stale: true }],
    [`attempt:${P}:call-1`, { stale: true }],
    [`assignment:${P}:cell-1`, { stale: true }],
    [`build-lock:${P}`, { stale: true }],
    [`cleanup-claim:${P}`, { stale: true }],
    [`${encodeURIComponent("pending-completion:")}:${encodeURIComponent(P)}:t1`, { stale: true }],
    [`legacy-tombstone:${P}:*`, { at: 1 }],
    [`legacy-tombstone:${P}:s1`, { at: 1 }],
    [`mission:${Q}:s1`, { other: true }],
    ["unrelated:key", { keep: true }],
  ];
  const kept = [
    `legacy-tombstone:${P}:*`,
    `legacy-tombstone:${P}:s1`,
    `mission:${Q}:s1`,
    "unrelated:key",
  ];

  async function requestStatus(db: DatabaseAdapter, project: string): Promise<unknown> {
    const row = (await db.query("SELECT status FROM swarmx_downgrade_requests WHERE project = ?", [project])).rows[0];
    return (row as { status?: unknown } | undefined)?.status;
  }

  // Break: consumer removing tombstones/unrelated keys, other projects' keys, or never completing.
  test("pluginConsumesDowngradePreservingTombstonesAndUnrelatedKeys", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    cleanups.push(async () => { await db.close?.(); });
    await ensureWorkUnitSchema(db);
    await seedMission(db, P, "m1", "FINISHED");
    await requestDowngrade(db, P);
    await requestDowngrade(db, Q);

    const ctx = createFakeContext({ projectId: P, storage: storage() });
    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);

    expect([...ctx.storage.map.keys()].sort()).toEqual([...kept].sort());
    expect(await requestStatus(db, P)).toBe("completed");
    expect(await requestStatus(db, Q)).toBe("pending");
  });

  // Break: request marked completed after partial failure, or no retry; lock-held cleanup.
  test("pluginDowngradeCleanupFailureRemainsRetryable", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    cleanups.push(async () => { await db.close?.(); });
    await ensureWorkUnitSchema(db);
    await requestDowngrade(db, P);

    const ctx = createFakeContext({ projectId: P, storage: storage() });
    const realRemove = ctx.storage.remove.bind(ctx.storage);
    let failNext = true;
    (ctx.storage as { remove: typeof realRemove }).remove = async (key) => {
      if (failNext && key.startsWith("budget:")) {
        failNext = false;
        throw new Error("disk full");
      }
      return realRemove(key);
    };

    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    expect(await requestStatus(db, P)).toBe("pending");
    expect(ctx.storage.map.has(`budget:${P}:s1`)).toBe(true);

    // A held project cleanup lock defers consumption without completing.
    const lock = await acquireWorkUnitLock(db, {
      name: cleanupLockName(P), token: "other", ownerSession: "other", now: Date.now(), staleAfterMs: 60_000,
    });
    expect(lock.acquired).toBe(true);
    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    expect(await requestStatus(db, P)).toBe("pending");
    expect(ctx.storage.map.has(`budget:${P}:s1`)).toBe(true);
    await db.query("DELETE FROM swarmx_locks WHERE name = ?", [cleanupLockName(P)]);

    // A mission opened after the request blocks consumption at recheck.
    await seedMission(db, P, "late", "OPEN");
    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    expect(await requestStatus(db, P)).toBe("pending");
    await db.query("UPDATE swarmx_missions SET state = 'FINISHED' WHERE id = 'late'");

    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    expect(await requestStatus(db, P)).toBe("completed");
    expect([...ctx.storage.map.keys()].sort()).toEqual([...kept].sort());
    const locks = (await db.query("SELECT COUNT(name) AS n FROM swarmx_locks")).rows[0] as { n: unknown };
    expect(Number(locks.n)).toBe(0);
  });
});

describe("command surface", () => {
  // Break: usage errors exiting 0/1, or non-envelope errors.
  test("commandOutputUsesStableExitCodes", async () => {
    const box = await sandbox();
    const both = cli(box, "recover", "--effect", "a", "--feedback", "b", "--json");
    expect(both.code).toBe(2);
    expect(both.json).toEqual({ error: { code: "usage_error", message: expect.any(String) } });
    expect(cli(box, "recover", "--bogus", "--json").code).toBe(2);
    expect(cli(box, "unit", "frobnicate", "--json").code).toBe(2);
    expect(cli(box, "downgrade", "--yes", "--json").code).toBe(2);
    const ok = cli(box, "recover", "--json");
    expect(ok.code).toBe(0);
    expect(Object.keys(ok.json).sort()).toEqual(["foreignHostEffects", "foreignHostFeedback", "recoveredEffects", "recoveredFeedback"]);
  });

  // Break: lifecycle commands leaking into the agent tool surface.
  test("commandsAreNotRegisteredAsAgentTools", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    cleanups.push(async () => { await db.close?.(); });
    const ctx = createFakeContext({ projectId: P, storage: [] });
    await createSwarmxPlugin({ workUnitDatabase: async () => db }).setup(ctx as unknown as Plugin.Context);
    const editor = ctx.createEditor();
    for (const transform of ctx.captures.toolTransforms) transform(editor);
    const names = editor.list().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /recover|revoke|downgrade/i.test(name))).toEqual([]);
  });
});
