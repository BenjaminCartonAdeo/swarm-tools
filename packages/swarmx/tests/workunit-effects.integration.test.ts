import { afterEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import {
  claimEffect,
  EffectClaimConflictError,
  EffectNotFoundError,
  recoverStaleEffects,
  recordEffectResult,
  recoverEffectClaim,
  DefiniteEffectError,
  drainWorkUnitEffects,
  runWorkUnitEffect,
  type HiveCellSnapshot,
  type WorkUnitEffectPorts,
} from "../src/workunit/effects.js";
import { transitionWorkUnit, beginMissionClose, MissionFenceConflictError, finalizePublish, finalizeReturn, EffectsNotSettledError } from "../src/workunit/store.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyExternal, CRASH_EXIT_CODE, readLedger, type CrashBoundary } from "./fixtures/workunit-effect-crash-child.js";
import { forceMissionClose, ForcedCloseNotAllowedError } from "../src/workunit/effects.js";

const databases: DatabaseAdapter[] = [];

async function seedEffect({
  effectId = "effect-1",
  unitId = "unit-1",
  unitState = "PUBLISHING",
  unitFence = 7,
  effectFence = unitFence,
  effectState = "pending",
}: {
  effectId?: string;
  unitId?: string;
  unitState?: "PUBLISHING" | "RETURNING";
  unitFence?: number;
  effectFence?: number;
  effectState?: "pending" | "unknown" | "in_flight";
} = {}): Promise<DatabaseAdapter> {
  const db = await createLibSQLAdapter({ url: ":memory:" });
  databases.push(db);
  await ensureWorkUnitSchema(db);
  await db.query(
    "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('mission-1', 'project', 'session', 'mission', 'OPEN', 1, 0, 0)",
  );
  await db.query(
    "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES (?, 'project', 'mission-1', ?, ?, 1, ?, ?, 0, 0)",
    [unitId, `call-${unitId}`, `idem-${unitId}`, unitState, unitFence],
  );
  await db.query(
    "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES (?, ?, 'backend_complete', 1, ?, ?, 0, 0)",
    [effectId, unitId, effectFence, effectState],
  );
  return db;
}

async function readEffect(db: DatabaseAdapter, effectId = "effect-1"): Promise<Record<string, unknown>> {
  const result = await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effectId]);
  return result.rows[0] as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close?.()));
});

describe("work unit effect journal claims", () => {
  test("effectClaimIsExclusive and persists the complete fenced claim", async () => {
    const db = await seedEffect();
    const input = {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING" as const,
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    };

    const [first, second] = await Promise.all([claimEffect(db, input), claimEffect(db, input)]);

    expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);
    const winner = first ?? second;
    expect(winner).not.toBeNull();
    const persisted = await readEffect(db);
    expect(persisted).toMatchObject({
      unit_fence: 7,
      state: "in_flight",
      claim_token: winner?.claimToken,
      host_instance_id: "host-1",
      claimed_hostname: "worker-a",
      claimed_by_pid: 321,
    });
    expect(typeof persisted.claim_token).toBe("string");
    expect(typeof persisted.claimed_at).toBe("number");
  });

  test("resultRequiresClaimToken", async () => {
    const db = await seedEffect();
    const claim = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });

    expect(claim).not.toBeNull();
    await expect(recordEffectResult(db, {
      effectId: "effect-1",
      claimToken: "not-the-current-token",
      state: "succeeded",
      result: { published: true },
    })).rejects.toBeInstanceOf(EffectClaimConflictError);
    await expect(recordEffectResult(db, {
      effectId: "missing-effect",
      claimToken: "any-token",
      state: "succeeded",
    })).rejects.toBeInstanceOf(EffectNotFoundError);

    const result = await recordEffectResult(db, {
      effectId: "effect-1",
      claimToken: claim!.claimToken,
      state: "succeeded",
      result: { published: true },
    });
    expect(result).toMatchObject({ state: "succeeded", result_json: '{"published":true}' });
    expect(result.claim_token).toBeNull();
    expect(result.host_instance_id).toBeNull();
  });

  test("deadSameHostPidBecomesUnknown", async () => {
    const db = await seedEffect();
    const claim = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });
    expect(claim).not.toBeNull();

    const recovered = await recoverStaleEffects(db, {
      hostInstanceId: "host-1",
      hostname: "worker-a",
      isProcessAlive: (pid) => pid !== 321,
    });

    expect(recovered).toEqual({ recovered: 1, foreignHostCandidates: [], recoveredEffects: ["effect-1"] });
    expect(await readEffect(db)).toMatchObject({
      state: "unknown",
      claim_token: null,
      host_instance_id: null,
      claimed_hostname: null,
      claimed_by_pid: null,
      claimed_at: null,
    });
  });

  test("liveForeignHostClaimIsNotRecovered", async () => {
    const db = await seedEffect();
    await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-foreign",
      hostname: "other-machine",
      pid: 654,
    });
    await db.query(
      "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('unit-live', 'project', 'mission-1', 'call-live', 'idem-live', 1, 'RETURNING', 3, 0, 0)",
    );
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('effect-live', 'unit-live', 'backend_complete', 1, 3, 'pending', 0, 0)",
    );
    await claimEffect(db, {
      effectId: "effect-live",
      unitId: "unit-live",
      expectedUnitState: "RETURNING",
      unitFence: 3,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });

    const recovered = await recoverStaleEffects(db, {
      hostInstanceId: "host-1",
      hostname: "worker-a",
      isProcessAlive: (pid) => pid === 321,
    });

    expect(recovered).toEqual({ recovered: 0, foreignHostCandidates: ["effect-1"], recoveredEffects: [] });
    expect(await readEffect(db)).toMatchObject({ state: "in_flight", host_instance_id: "host-foreign" });
    expect(await readEffect(db, "effect-live")).toMatchObject({ state: "in_flight", host_instance_id: "host-1" });
  });

  test("runnerRejectsStaleUnitFence", async () => {
    const db = await seedEffect({ unitFence: 8, effectFence: 7 });

    const claim = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });

    expect(claim).toBeNull();
    expect(await readEffect(db)).toMatchObject({ state: "pending", claim_token: null });
  });

  test("lateResolveFromStaleTokenIsRejectedAfterRecoveryAndReclaim", async () => {
    const db = await seedEffect();
    const original = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });
    expect(original).not.toBeNull();

    await recoverStaleEffects(db, {
      hostInstanceId: "host-1",
      hostname: "worker-a",
      isProcessAlive: () => false,
    });
    const replacement = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-2",
      hostname: "worker-b",
      pid: 987,
    });

    expect(replacement).not.toBeNull();
    expect(replacement?.claimToken).not.toBe(original?.claimToken);
    await expect(recordEffectResult(db, {
      effectId: "effect-1",
      claimToken: original!.claimToken,
      state: "succeeded",
      result: { stale: true },
    })).rejects.toBeInstanceOf(EffectClaimConflictError);
    expect((await readEffect(db)).state).toBe("in_flight");
  });
});

const HOST = { hostInstanceId: "host-1", hostname: "worker-a", pid: 321 };
const RECEIPT_JSON = '{"tests":"passed"}';

interface EffectSeed {
  effectId: string;
  kind: string;
  mandatory: boolean;
  request: unknown;
  operationId?: string;
  state?: string;
}

async function seedUnit(
  effects: EffectSeed[],
  { unitState = "PUBLISHING", fence = 4 }: { unitState?: "PUBLISHING" | "RETURNING"; fence?: number } = {},
): Promise<DatabaseAdapter> {
  const db = await createLibSQLAdapter({ url: ":memory:" });
  databases.push(db);
  await ensureWorkUnitSchema(db);
  await db.query(
    "INSERT INTO swarmx_missions (id, project, session_id, mission_id, epic_id, state, fence, created_at, updated_at) VALUES ('mission-1', 'proj', 'session', 'mission', 'epic-9', 'OPEN', 1, 0, 0)",
  );
  await db.query(
    "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, verification_receipt_json, created_at, updated_at) VALUES ('unit-1', 'proj', 'mission-1', 'call-1', 'cell-1', 'idem-1', 1, ?, ?, ?, 0, 0)",
    [unitState, fence, RECEIPT_JSON],
  );
  for (const effect of effects) {
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, operation_id, unit_fence, state, attempt, request_json, updated_at) VALUES (?, 'unit-1', ?, ?, ?, ?, ?, 0, ?, 0)",
      [effect.effectId, effect.kind, effect.mandatory ? 1 : 0, effect.operationId ?? effect.effectId, fence, effect.state ?? "pending", JSON.stringify(effect.request)],
    );
  }
  return db;
}

interface FakePorts extends WorkUnitEffectPorts {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  consolidations: unknown[];
  order: string[];
}

function fakePorts({
  cells = [],
  tool = async () => ({ ok: true }),
  consolidate = async () => ({ ok: true }),
}: {
  cells?: Array<HiveCellSnapshot | null>;
  tool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  consolidate?: () => Promise<unknown>;
} = {}): FakePorts {
  const ports: FakePorts = {
    calls: [],
    consolidations: [],
    order: [],
    async readHiveCell(projectKey, cellId) {
      ports.order.push(`read:${projectKey}:${cellId}`);
      return cells.length > 1 ? cells.shift()! : (cells[0] ?? null);
    },
    async runBackendTool(name, args) {
      ports.calls.push({ name, args });
      ports.order.push(`tool:${name}`);
      return tool(name, args);
    },
    async prepareConsolidation(input) {
      ports.consolidations.push(input);
      ports.order.push("consolidate");
      return consolidate();
    },
  };
  return ports;
}

const COMPLETE_ARGS = { project_key: "proj", bead_id: "cell-1", summary: "done", files_touched: ["a.ts"] };

describe("work unit effect runner", () => {
  test("effectSchemaStoresRequestJsonIdempotently", async () => {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    databases.push(db);
    await db.exec(
      "CREATE TABLE swarmx_effects (effect_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, kind TEXT NOT NULL, mandatory INTEGER NOT NULL, operation_id TEXT, unit_fence INTEGER NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, claim_token TEXT, host_instance_id TEXT, claimed_hostname TEXT, claimed_by_pid INTEGER, claimed_at INTEGER, result_json TEXT, error_json TEXT, updated_at INTEGER NOT NULL)",
    );
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, updated_at) VALUES ('legacy', 'u', 'hive_start', 0, 1, 'pending', 0)",
    );
    await ensureWorkUnitSchema(db);
    await ensureWorkUnitSchema(db);
    const columns = await db.query("PRAGMA table_info(swarmx_effects)");
    expect(columns.rows.filter((row) => (row as { name: string }).name === "request_json")).toHaveLength(1);
    expect(await readEffect(db, "legacy")).toMatchObject({ effect_id: "legacy", request_json: null });
  });

  test("runnerUsesStoredRequestJsonForReplay", async () => {
    const request = { project_key: "proj", bead_id: "cell-1", summary: "exact ✓", nested: { list: [1, "two"] } };
    const db = await seedUnit([{ effectId: "eff-hs", kind: "hive_start", mandatory: false, request }]);
    const ports = fakePorts();
    const effect = await runWorkUnitEffect(db, { effectId: "eff-hs", host: HOST, ports });
    expect(ports.calls).toEqual([{ name: "hive_start", args: request }]);
    expect(effect.state).toBe("succeeded");
  });

  test("missing effect throws EffectNotFoundError", async () => {
    const db = await seedUnit([]);
    await expect(runWorkUnitEffect(db, { effectId: "nope", host: HOST, ports: fakePorts() }))
      .rejects.toBeInstanceOf(EffectNotFoundError);
  });

  test("stale unit fence marks the effect orphaned without executing", async () => {
    const db = await seedUnit([{ effectId: "eff-hs", kind: "hive_start", mandatory: false, request: {} }]);
    await db.query("UPDATE swarmx_work_units SET fence = 5 WHERE id = 'unit-1'");
    const ports = fakePorts();
    const effect = await runWorkUnitEffect(db, { effectId: "eff-hs", host: HOST, ports });
    expect(effect.state).toBe("orphaned");
    expect(ports.calls).toEqual([]);
  });

  test("busy claim returns the current effect without executing", async () => {
    const db = await seedUnit([{ effectId: "eff-hs", kind: "hive_start", mandatory: false, request: {} }]);
    await claimEffect(db, { effectId: "eff-hs", unitId: "unit-1", expectedUnitState: "PUBLISHING", unitFence: 4, hostInstanceId: "other", hostname: "b", pid: 9 });
    const ports = fakePorts();
    const effect = await runWorkUnitEffect(db, { effectId: "eff-hs", host: HOST, ports });
    expect(effect).toMatchObject({ state: "in_flight", host_instance_id: "other" });
    expect(ports.calls).toEqual([]);
  });

  test("completeReconcilesCellAndReceiptAfterUnknown", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS, state: "unknown" }]);
    const ports = fakePorts({ cells: [{ status: "closed", completionOperationId: "eff-c" }] });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(effect.state).toBe("succeeded");
    expect(ports.calls).toEqual([]);
    expect(ports.order).toEqual(["read:proj:cell-1"]);
  });

  test("openCellRetriesComplete", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS, state: "unknown" }]);
    const ports = fakePorts({ cells: [{ status: "open" }, { status: "closed", completionOperationId: "eff-c" }] });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(ports.calls).toEqual([{ name: "swarm_complete", args: { ...COMPLETE_ARGS, operation_id: "eff-c" } }]);
    expect(ports.order).toEqual(["read:proj:cell-1", "tool:swarm_complete", "read:proj:cell-1"]);
    expect(effect.state).toBe("succeeded");
  });

  test("preCompletionReadFailureRecordsUnknownAndClearsClaim", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
    const ports = fakePorts();
    ports.readHiveCell = async () => { throw new Error("hive unavailable"); };

    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });

    expect(effect.state).toBe("unknown");
    expect(effect.claim_token).toBeNull();
    expect(JSON.parse(effect.error_json!)).toMatchObject({ message: "hive unavailable" });
  });

  test("definitePreCompletionReadFailureRecordsFailedMandatory", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
    const ports = fakePorts();
    ports.readHiveCell = async () => { throw new DefiniteEffectError("cell read rejected"); };

    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });

    expect(effect.state).toBe("failed_mandatory");
    expect(effect.claim_token).toBeNull();
    expect(JSON.parse(effect.error_json!)).toMatchObject({ name: "DefiniteEffectError", message: "cell read rejected" });
  });

  test("postCompletionReadFailureRetriesWithoutDuplicateSideEffect", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
    let readCount = 0;
    const ports = fakePorts();
    ports.readHiveCell = async () => {
      readCount += 1;
      if (readCount === 1) return { status: "open" };
      if (readCount === 2) throw new Error("hive unavailable after completion");
      return { status: "closed", completionOperationId: "eff-c" };
    };

    const first = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(first.state).toBe("unknown");
    expect(first.claim_token).toBeNull();
    expect(JSON.parse(first.error_json!)).toMatchObject({ message: "hive unavailable after completion" });

    const retried = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(retried.state).toBe("succeeded");
    expect(ports.calls).toEqual([{ name: "swarm_complete", args: { ...COMPLETE_ARGS, operation_id: "eff-c" } }]);
  });

  test("null cell retries complete and ambiguous tool error stays unknown", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
    const ports = fakePorts({ cells: [null], tool: async () => { throw new Error("socket hang up"); } });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(ports.calls).toHaveLength(1);
    expect(effect.state).toBe("unknown");
  });

  test("closedCellWithoutMatchingCompletionIdentityFailsMandatory", async () => {
    for (const cell of [{ status: "closed" }, { status: "closed", completionOperationId: "other-identity" }]) {
      const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
      const ports = fakePorts({ cells: [cell] });
      const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
      expect(effect.state).toBe("failed_mandatory");
      expect(ports.calls).toEqual([]);
      expect(effect.error_json).not.toBeNull();
    }
  });

  test("mandatory effects with null or malformed request_json never call a port", async () => {
    const cases: Array<[string, "PUBLISHING" | "RETURNING", string | null]> = [
      ["backend_complete", "PUBLISHING", null],
      ["backend_complete", "PUBLISHING", "{not json"],
      ["backend_complete", "PUBLISHING", "[1,2]"],
      ["backend_feedback", "RETURNING", null],
      ["backend_feedback", "RETURNING", "\"string\""],
    ];
    for (const [kind, unitState, raw] of cases) {
      const db = await seedUnit([{ effectId: "eff-m", kind, mandatory: true, request: {} }], { unitState });
      await db.query("UPDATE swarmx_effects SET request_json = ? WHERE effect_id = 'eff-m'", [raw]);
      const ports = fakePorts({ cells: [{ status: "open" }] });
      const effect = await runWorkUnitEffect(db, { effectId: "eff-m", host: HOST, ports });
      expect(effect.state).toBe("failed_mandatory");
      expect(ports.order).toEqual([]);
    }
  });

  test("missing cell_id fails backend_complete deterministically without calling ports", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
    await db.query("UPDATE swarmx_work_units SET cell_id = NULL WHERE id = 'unit-1'");
    const ports = fakePorts();
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(effect.state).toBe("failed_mandatory");
    expect(JSON.parse(effect.error_json!)).toEqual({ message: "WorkUnit has no cell_id to complete" });
    expect(ports.order).toEqual([]);
  });

  test("feedbackUsesOperationIdAfterUnknown", async () => {
    const request = { project_key: "proj", task_id: "cell-1", status: "needs_changes", issues: "[]" };
    const db = await seedUnit(
      [{ effectId: "eff-f", kind: "backend_feedback", mandatory: true, request, operationId: "op-feedback-1", state: "unknown" }],
      { unitState: "RETURNING" },
    );
    const ports = fakePorts();
    const effect = await runWorkUnitEffect(db, { effectId: "eff-f", host: HOST, ports });
    expect(ports.calls).toEqual([{ name: "swarm_review_feedback", args: { ...request, operation_id: "op-feedback-1" } }]);
    expect(effect.state).toBe("succeeded");
  });

  test("feedback definite failure is failed_mandatory, ambiguous is unknown", async () => {
    const cases: Array<[Error, string]> = [[new DefiniteEffectError("rejected"), "failed_mandatory"], [new Error("timeout"), "unknown"]];
    for (const [error, state] of cases) {
      const db = await seedUnit([{ effectId: "eff-f", kind: "backend_feedback", mandatory: true, request: {} }], { unitState: "RETURNING" });
      const effect = await runWorkUnitEffect(db, { effectId: "eff-f", host: HOST, ports: fakePorts({ tool: async () => { throw error; } }) });
      expect(effect.state as string).toBe(state);
    }
  });

  test("consolidate uses mission epic and failure is failed_optional", async () => {
    const db = await seedUnit([{ effectId: "eff-k", kind: "consolidate", mandatory: false, request: { projectKey: "proj", epicId: "epic-9", unitId: "unit-1" } }]);
    const ports = fakePorts({ consolidate: async () => { throw new Error("boom"); } });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-k", host: HOST, ports });
    expect(ports.consolidations).toEqual([{ projectKey: "proj", epicId: "epic-9", unitId: "unit-1" }]);
    expect(effect.state).toBe("failed_optional");
  });

  test("consolidate without resolvable epic_id makes no port call and is failed_optional", async () => {
    const db = await seedUnit([{ effectId: "eff-k", kind: "consolidate", mandatory: false, request: { projectKey: "proj", unitId: "unit-1" } }]);
    await db.query("UPDATE swarmx_missions SET epic_id = NULL WHERE id = 'mission-1'");
    const ports = fakePorts();
    const effect = await runWorkUnitEffect(db, { effectId: "eff-k", host: HOST, ports });
    expect(effect.state).toBe("failed_optional");
    expect(ports.order).toEqual([]);
  });

  test("multipleFollowupsUseDistinctOperationIds", async () => {
    const db = await seedUnit([
      { effectId: "eff-f0", kind: "followup:0", mandatory: false, request: { title: "A", parent_id: "epic-9" }, operationId: "op-0" },
      { effectId: "eff-f1", kind: "followup:1", mandatory: false, request: { title: "B", parent_id: "epic-9" }, operationId: "op-1" },
    ]);
    let n = 0;
    const ports = fakePorts({ tool: async () => ({ id: `new-cell-${n++}` }) });
    const first = await runWorkUnitEffect(db, { effectId: "eff-f0", host: HOST, ports });
    const second = await runWorkUnitEffect(db, { effectId: "eff-f1", host: HOST, ports });
    expect(ports.calls).toEqual([
      { name: "hive_create", args: { title: "A", parent_id: "epic-9", operation_id: "op-0" } },
      { name: "hive_create", args: { title: "B", parent_id: "epic-9", operation_id: "op-1" } },
    ]);
    expect(JSON.parse(first.result_json!)).toEqual({ cellId: "new-cell-0" });
    expect(JSON.parse(second.result_json!)).toEqual({ cellId: "new-cell-1" });
  });

  test("followup failure is failed_optional", async () => {
    const db = await seedUnit([{ effectId: "eff-f0", kind: "followup:0", mandatory: false, request: {} }]);
    const effect = await runWorkUnitEffect(db, { effectId: "eff-f0", host: HOST, ports: fakePorts({ tool: async () => { throw new Error("x"); } }) });
    expect(effect.state).toBe("failed_optional");
  });

  test("drainRunsMandatoryBeforeOptional", async () => {
    const db = await seedUnit([
      { effectId: "e-start", kind: "hive_start", mandatory: false, request: { s: 1 } },
      { effectId: "e-f10", kind: "followup:10", mandatory: false, request: { t: 10 } },
      { effectId: "e-f2", kind: "followup:2", mandatory: false, request: { t: 2 } },
      { effectId: "e-cons", kind: "consolidate", mandatory: false, request: { projectKey: "proj", epicId: "epic-9", unitId: "unit-1" } },
      { effectId: "e-complete", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS },
    ]);
    const ports = fakePorts({ cells: [{ status: "closed", completionOperationId: "e-complete" }], tool: async () => ({ id: "c" }) });
    const result = await drainWorkUnitEffects(db, { unitId: "unit-1", host: HOST, ports });
    expect(ports.order).toEqual(["read:proj:cell-1", "consolidate", "tool:hive_create", "tool:hive_create", "tool:hive_start"]);
    expect(ports.calls.map((call) => call.args)).toEqual([{ t: 2, operation_id: "e-f2" }, { t: 10, operation_id: "e-f10" }, { s: 1 }]);
    expect(result.unit.state).toBe("PUBLISHING");
    expect(result.effects.every((effect) => effect.state === "succeeded")).toBe(true);
  });

  test("drainStopsOptionalWhenMandatoryFails", async () => {
    const db = await seedUnit([
      { effectId: "e-complete", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS },
      { effectId: "e-cons", kind: "consolidate", mandatory: false, request: {} },
      { effectId: "e-start", kind: "hive_start", mandatory: false, request: {} },
    ]);
    const ports = fakePorts({ cells: [{ status: "closed", completionOperationId: "other-identity" }] });
    const result = await drainWorkUnitEffects(db, { unitId: "unit-1", host: HOST, ports });
    expect(ports.order).toEqual(["read:proj:cell-1"]);
    const states = Object.fromEntries(result.effects.map((effect) => [effect.effect_id, effect.state]));
    expect(states).toEqual({ "e-complete": "failed_mandatory", "e-cons": "pending", "e-start": "pending" });
  });

  test("optionalEffectFailureDoesNotBlockDone", async () => {
    const db = await seedUnit([
      { effectId: "e-complete", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS },
      { effectId: "e-f0", kind: "followup:0", mandatory: false, request: {} },
      { effectId: "e-start", kind: "hive_start", mandatory: false, request: {} },
    ]);
    const ports = fakePorts({
      cells: [{ status: "closed", completionOperationId: "e-complete" }],
      tool: async () => { throw new Error("hive down"); },
    });
    const result = await drainWorkUnitEffects(db, { unitId: "unit-1", host: HOST, ports });
    const states = Object.fromEntries(result.effects.map((effect) => [effect.effect_id, effect.state]));
    expect(states).toEqual({ "e-complete": "succeeded", "e-f0": "failed_optional", "e-start": "failed_optional" });
    const done = await transitionWorkUnit(db, { unitId: "unit-1", expectedState: "PUBLISHING", unitFence: result.unit.fence, nextState: "DONE", patch: { kind: "finalize" } });
    expect(done.state).toBe("DONE");
  });
});

describe("forced mission close", () => {
  const owner = { missionPk: "mission-1", ownerSessionId: "session" };

  async function seedForced(): Promise<DatabaseAdapter> {
    const db = await seedEffect({ effectId: "pub-mandatory", unitId: "pub", unitState: "PUBLISHING", unitFence: 7 });
    await db.query(
      "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('ret', 'project', 'mission-1', 'call-ret', 'idem-ret', 1, 'RETURNING', 4, 0, 0)",
    );
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('ret-mandatory', 'ret', 'backend_return', 1, 4, 'failed_mandatory', 1, 0)",
    );
    await beginMissionClose(db, { ...owner, expectedFence: 1, intent: "finish" });
    return db;
  }

  async function states(db: DatabaseAdapter, table: "units" | "effects"): Promise<Record<string, unknown>> {
    const sql = table === "units"
      ? "SELECT id AS k, state FROM swarmx_work_units ORDER BY id"
      : "SELECT effect_id AS k, state FROM swarmx_effects ORDER BY effect_id";
    const result = await db.query(sql);
    return Object.fromEntries(result.rows.map((row) => [(row as Record<string, unknown>).k, (row as Record<string, unknown>).state]));
  }

  test("forcedCloseRequiresFailedMandatoryEvidence for every live unit", async () => {
    const db = await seedForced();
    await expect(forceMissionClose(db, { ...owner, expectedFence: 2 })).rejects.toBeInstanceOf(ForcedCloseNotAllowedError);
    expect(await states(db, "units")).toEqual({ pub: "PUBLISHING", ret: "RETURNING" });
    expect(await states(db, "effects")).toEqual({ "pub-mandatory": "pending", "ret-mandatory": "failed_mandatory" });
    await db.query("UPDATE swarmx_work_units SET state = 'BOUND' WHERE id = 'pub'");
    await db.query("UPDATE swarmx_effects SET state = 'failed_mandatory' WHERE effect_id = 'pub-mandatory'");
    await expect(forceMissionClose(db, { ...owner, expectedFence: 2 })).rejects.toBeInstanceOf(ForcedCloseNotAllowedError);
    await expect(forceMissionClose(db, { ...owner, ownerSessionId: "intruder", expectedFence: 2 })).rejects.toBeInstanceOf(MissionFenceConflictError);
  });

  test("forcedCloseInvalidatesLateEffectResults", async () => {
    const db = await seedForced();
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('pub-failed', 'pub', 'hive_close', 1, 7, 'failed_mandatory', 1, 0)",
    );
    const claim = await claimEffect(db, {
      effectId: "pub-mandatory", unitId: "pub", expectedUnitState: "PUBLISHING", unitFence: 7,
      hostInstanceId: "host", hostname: "h", pid: 1,
    });
    expect(claim).not.toBeNull();
    await forceMissionClose(db, { ...owner, expectedFence: 2 });
    await expect(recordEffectResult(db, { effectId: "pub-mandatory", claimToken: claim!.claimToken, state: "succeeded" }))
      .rejects.toBeInstanceOf(EffectClaimConflictError);
    expect(await readEffect(db, "pub-mandatory")).toMatchObject({ state: "orphaned", claim_token: null });
  });

  test("forcedCloseCrashAfterOrphaningConvergesOnRetry", async () => {
    const db = await seedForced();
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('pub-failed', 'pub', 'hive_close', 1, 7, 'failed_mandatory', 1, 0)",
    );
    const claim = await claimEffect(db, {
      effectId: "pub-mandatory", unitId: "pub", expectedUnitState: "PUBLISHING", unitFence: 7,
      hostInstanceId: "host", hostname: "h", pid: 1,
    });
    expect(claim).not.toBeNull();
    // Simulated crash: step 1 (orphan + clear claims) committed, step 2 (units FAILED) never ran.
    await db.query(
      "UPDATE swarmx_effects SET state = 'orphaned', claim_token = NULL, host_instance_id = NULL, claimed_hostname = NULL, claimed_by_pid = NULL, claimed_at = NULL WHERE effect_id = 'pub-mandatory'",
    );
    expect(await states(db, "units")).toEqual({ pub: "PUBLISHING", ret: "RETURNING" });
    expect(await forceMissionClose(db, { ...owner, expectedFence: 2 })).toMatchObject({ state: "FINISHED", fence: 3 });
    expect(await states(db, "units")).toEqual({ pub: "FAILED", ret: "FAILED" });
    await expect(recordEffectResult(db, { effectId: "pub-mandatory", claimToken: claim!.claimToken, state: "succeeded" }))
      .rejects.toBeInstanceOf(EffectClaimConflictError);
    expect(await forceMissionClose(db, { ...owner, expectedFence: 2 })).toMatchObject({ state: "FINISHED", fence: 3 });
  });

  test("approvedUnitWithEffectsIsNotForceClosable (documented limitation)", async () => {
    const db = await seedForced();
    await db.query("UPDATE swarmx_effects SET state = 'failed_mandatory' WHERE effect_id = 'pub-mandatory'");
    await db.query("UPDATE swarmx_work_units SET state = 'APPROVED' WHERE id = 'ret'");
    await expect(forceMissionClose(db, { ...owner, expectedFence: 2 })).rejects.toBeInstanceOf(ForcedCloseNotAllowedError);
    expect(await states(db, "units")).toEqual({ pub: "PUBLISHING", ret: "APPROVED" });
  });

  test("mandatoryFailureAllowsCoordinatorForcedClose idempotently and leaves no live units", async () => {
    const db = await seedForced();
    await db.query("UPDATE swarmx_effects SET state = 'failed_mandatory' WHERE effect_id = 'pub-mandatory'");
    const closed = await forceMissionClose(db, { ...owner, expectedFence: 2 });
    expect(closed).toMatchObject({ state: "FINISHED", fence: 3 });
    expect(await states(db, "units")).toEqual({ pub: "FAILED", ret: "FAILED" });
    expect(await forceMissionClose(db, { ...owner, expectedFence: 2 })).toMatchObject({ state: "FINISHED", fence: 3 });
  });
});

describe("explicit effect claim recovery", () => {
  async function claimed(db: DatabaseAdapter): Promise<string> {
    const claim = await claimEffect(db, {
      effectId: "effect-1", unitId: "unit-1", expectedUnitState: "PUBLISHING", unitFence: 7,
      hostInstanceId: "host-foreign", hostname: "other-machine", pid: 654,
    });
    return claim!.claimToken;
  }

  // Break: recovery that ignores the observed token and clobbers a newer claim.
  test("recoverEffectClaimCasInvalidatesStaleToken", async () => {
    const db = await seedEffect();
    const token = await claimed(db);

    await expect(recoverEffectClaim(db, { effectId: "effect-1", expectedClaimToken: "not-it" }))
      .rejects.toBeInstanceOf(EffectClaimConflictError);
    expect(await readEffect(db)).toMatchObject({ state: "in_flight", claim_token: token });

    await expect(recoverEffectClaim(db, { effectId: "effect-1", expectedClaimToken: token, project: "elsewhere" }))
      .rejects.toBeInstanceOf(EffectNotFoundError);
    await expect(recoverEffectClaim(db, { effectId: "missing", expectedClaimToken: token }))
      .rejects.toBeInstanceOf(EffectNotFoundError);

    const recovered = await recoverEffectClaim(db, { effectId: "effect-1", expectedClaimToken: token, project: "project" });
    expect(recovered).toMatchObject({ effect_id: "effect-1", state: "unknown", claim_token: null, host_instance_id: null, claimed_by_pid: null });

    // The stale owner can no longer record a result, and a replayed recovery conflicts.
    await expect(recordEffectResult(db, { effectId: "effect-1", claimToken: token, state: "succeeded" }))
      .rejects.toBeInstanceOf(EffectClaimConflictError);
    await expect(recoverEffectClaim(db, { effectId: "effect-1", expectedClaimToken: token }))
      .rejects.toBeInstanceOf(EffectClaimConflictError);
  });

  // Break: stale recovery ignoring the project filter.
  test("recoverStaleEffectsProjectFilter", async () => {
    const db = await seedEffect();
    await claimEffect(db, {
      effectId: "effect-1", unitId: "unit-1", expectedUnitState: "PUBLISHING", unitFence: 7,
      hostInstanceId: "host-1", hostname: "worker-a", pid: 321,
    });
    const other = await recoverStaleEffects(db, { hostInstanceId: "host-1", hostname: "worker-a", isProcessAlive: () => false, project: "other" });
    expect(other).toEqual({ recovered: 0, foreignHostCandidates: [], recoveredEffects: [] });
    const mine = await recoverStaleEffects(db, { hostInstanceId: "host-1", hostname: "worker-a", isProcessAlive: () => false, project: "project" });
    expect(mine).toEqual({ recovered: 1, foreignHostCandidates: [], recoveredEffects: ["effect-1"] });
  });
});

describe("effect crash recovery at every boundary", () => {
  const CRASH_HOST = { hostInstanceId: "crash-host", hostname: "crash-box" };
  const boundaries: CrashBoundary[] = ["before_claim", "after_claim", "after_side_effect", "before_result_write", "after_result_write"];
  const kinds = [
    { kind: "backend_complete", unitState: "PUBLISHING", tool: "swarm_complete", request: COMPLETE_ARGS, operationId: "eff-crash", finalState: "DONE" },
    { kind: "backend_feedback", unitState: "RETURNING", tool: "swarm_review_feedback", request: { project_key: "proj", task_id: "cell-1", status: "needs_changes", issues: "[]" }, operationId: "op-feedback-crash", finalState: "CHANGES_REQUESTED" },
  ] as const;
  const crashChild = join(import.meta.dir, "fixtures", "workunit-effect-crash-child.ts");

  for (const spec of kinds) {
    for (const boundary of boundaries) {
      test(`crash restart boundary ${spec.kind} ${boundary}`, async () => {
        await mkdir("/tmp/opencode", { recursive: true });
        const tempDir = await mkdtemp(join("/tmp/opencode", "swarmx-effect-crash-"));
        const dbPath = join(tempDir, "swarm.db");
        const ledgerPath = join(tempDir, "ledger.jsonl");
        const tokenPath = join(tempDir, "token");
        let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
        let db: DatabaseAdapter | undefined;
        try {
          const seedDb = await createLibSQLAdapter({ url: `file:${dbPath}` });
          try {
            await ensureWorkUnitSchema(seedDb);
            await seedDb.query("INSERT INTO swarmx_missions (id, project, session_id, mission_id, epic_id, state, fence, created_at, updated_at) VALUES ('mission-1', 'proj', 'session', 'mission', 'epic-9', 'OPEN', 1, 0, 0)");
            await seedDb.query(
              "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, verification_receipt_json, created_at, updated_at) VALUES ('unit-1', 'proj', 'mission-1', 'call-1', 'cell-1', 'idem-1', 1, ?, 4, ?, 0, 0)",
              [spec.unitState, RECEIPT_JSON],
            );
            await seedDb.query(
              "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, operation_id, unit_fence, state, attempt, request_json, updated_at) VALUES ('eff-crash', 'unit-1', ?, 1, ?, 4, 'pending', 0, ?, 0)",
              [spec.kind, spec.operationId, JSON.stringify(spec.request)],
            );
          } finally {
            await seedDb.close?.();
          }

          child = Bun.spawn([process.execPath, crashChild], {
            env: {
              ...process.env,
              SWARM_DB_PATH: dbPath,
              SWARMX_CRASH_AT: boundary,
              SWARMX_EFFECT_ID: "eff-crash",
              SWARMX_LEDGER_PATH: ledgerPath,
              SWARMX_TOKEN_PATH: tokenPath,
              SWARMX_HOST_INSTANCE_ID: CRASH_HOST.hostInstanceId,
              SWARMX_HOSTNAME: CRASH_HOST.hostname,
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          const childPid = child.pid;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const exitCode = await Promise.race([
            child.exited,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`crash child ${boundary} did not exit in 15s`)), 15_000); }),
          ]).finally(() => clearTimeout(timer));
          const stderr = await new Response(child.stderr).text();
          expect({ boundary, exitCode, stderr: stderr.trim() }).toEqual({ boundary, exitCode: CRASH_EXIT_CODE, stderr: "" });

          db = await createLibSQLAdapter({ url: `file:${dbPath}` });
          const afterCrash = await readEffect(db, "eff-crash");
          const expectedCrashState = boundary === "before_claim" ? "pending" : boundary === "after_result_write" ? "succeeded" : "in_flight";
          expect({ boundary, state: afterCrash.state }).toEqual({ boundary, state: expectedCrashState });
          const sideEffectHappened = boundary === "after_side_effect" || boundary === "before_result_write" || boundary === "after_result_write";
          expect(readLedger(ledgerPath)).toHaveLength(sideEffectHappened ? 1 : 0);

          // DONE / CHANGES_REQUESTED stays blocked until the mandatory effect resolves.
          const finalize = spec.kind === "backend_complete" ? finalizePublish : finalizeReturn;
          if (boundary !== "after_result_write") {
            await expect(finalize(db, { unitId: "unit-1", unitFence: 4 })).rejects.toBeInstanceOf(EffectsNotSettledError);
          }

          const recovery = await recoverStaleEffects(db, { ...CRASH_HOST, isProcessAlive: (pid) => pid !== childPid });
          const claimedAtCrash = boundary === "after_claim" || boundary === "after_side_effect" || boundary === "before_result_write";
          expect(recovery.recoveredEffects).toEqual(claimedAtCrash ? ["eff-crash"] : []);
          expect((await readEffect(db, "eff-crash")).state).toBe(claimedAtCrash ? "unknown" : expectedCrashState);

          if (boundary !== "before_claim") {
            const staleToken = readFileSync(tokenPath, "utf8");
            await expect(recordEffectResult(db, { effectId: "eff-crash", claimToken: staleToken, state: "succeeded", result: {} }))
              .rejects.toBeInstanceOf(EffectClaimConflictError);
          }

          const ledgerHasOp = () => readLedger(ledgerPath).some((entry) => entry.operation_id === spec.operationId && entry.applied);
          const ports = fakePorts({ tool: async (name, args) => applyExternal(ledgerPath, name, args) });
          ports.readHiveCell = async (projectKey, cellId) => {
            ports.order.push(`read:${projectKey}:${cellId}`);
            return ledgerHasOp() ? { status: "closed", completionOperationId: spec.operationId } : { status: "open" };
          };
          const drained = await drainWorkUnitEffects(db, { unitId: "unit-1", host: { ...CRASH_HOST, pid: process.pid }, ports });
          expect(drained.effects.find((effect) => effect.effect_id === "eff-crash")?.state).toBe("succeeded");

          const toolCalls = ports.calls.filter((call) => call.name === spec.tool);
          const expectReplay = boundary !== "after_result_write" && !(spec.kind === "backend_complete" && sideEffectHappened);
          expect(toolCalls).toEqual(expectReplay ? [{ name: spec.tool, args: { ...spec.request, operation_id: spec.operationId } }] : []);

          const ledger = readLedger(ledgerPath);
          expect(ledger.every((entry) => entry.operation_id === spec.operationId)).toBe(true);
          expect(ledger.filter((entry) => entry.applied)).toHaveLength(1);

          const final = await finalize(db, { unitId: "unit-1", unitFence: 4 });
          expect({ boundary, state: final.state, fence: final.fence }).toEqual({ boundary, state: spec.finalState, fence: 5 });
        } finally {
          if (child !== undefined && child.exitCode === null) {
            try { child.kill(); } catch { /* already exited */ }
          }
          await child?.exited;
          await db?.close?.();
          await rm(tempDir, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }
});
