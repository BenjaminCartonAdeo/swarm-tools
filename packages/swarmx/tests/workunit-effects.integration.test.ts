import { afterEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import {
  claimEffect,
  EffectClaimConflictError,
  EffectNotFoundError,
  recoverStaleEffects,
  recordEffectResult,
  DefiniteEffectError,
  drainWorkUnitEffects,
  runWorkUnitEffect,
  type HiveCellSnapshot,
  type WorkUnitEffectPorts,
} from "../src/workunit/effects.js";
import { transitionWorkUnit } from "../src/workunit/store.js";

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

    expect(recovered).toEqual({ recovered: 1, foreignHostCandidates: [] });
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

    expect(recovered).toEqual({ recovered: 0, foreignHostCandidates: ["effect-1"] });
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
// sha256('{"tests":"passed"}') computed by hand with `printf '{"tests":"passed"}' | sha256sum`
const RECEIPT_JSON = '{"tests":"passed"}';
const RECEIPT_HASH = "46ef157866dc6cc874adcc9f868330c33356f8bc3cf0bd2cb903f596912ae56b";

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
    const ports = fakePorts({ cells: [{ status: "closed", receiptHash: RECEIPT_HASH }] });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(effect.state).toBe("succeeded");
    expect(ports.calls).toEqual([]);
    expect(ports.order).toEqual(["read:proj:cell-1"]);
  });

  test("openCellRetriesComplete", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS, state: "unknown" }]);
    const ports = fakePorts({ cells: [{ status: "open" }, { status: "closed", receiptHash: RECEIPT_HASH }] });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(ports.calls).toEqual([{ name: "swarm_complete", args: COMPLETE_ARGS }]);
    expect(ports.order).toEqual(["read:proj:cell-1", "tool:swarm_complete", "read:proj:cell-1"]);
    expect(effect.state).toBe("succeeded");
  });

  test("null cell retries complete and ambiguous tool error stays unknown", async () => {
    const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
    const ports = fakePorts({ cells: [null], tool: async () => { throw new Error("socket hang up"); } });
    const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
    expect(ports.calls).toHaveLength(1);
    expect(effect.state).toBe("unknown");
  });

  test("closedCellWithoutMatchingReceiptFailsMandatory", async () => {
    for (const cell of [{ status: "closed" }, { status: "closed", receiptHash: "deadbeef" }]) {
      const db = await seedUnit([{ effectId: "eff-c", kind: "backend_complete", mandatory: true, request: COMPLETE_ARGS }]);
      const ports = fakePorts({ cells: [cell] });
      const effect = await runWorkUnitEffect(db, { effectId: "eff-c", host: HOST, ports });
      expect(effect.state).toBe("failed_mandatory");
      expect(ports.calls).toEqual([]);
      expect(effect.error_json).not.toBeNull();
    }
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
    const ports = fakePorts({ cells: [{ status: "closed", receiptHash: RECEIPT_HASH }], tool: async () => ({ id: "c" }) });
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
    const ports = fakePorts({ cells: [{ status: "closed", receiptHash: "mismatch" }] });
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
      cells: [{ status: "closed", receiptHash: RECEIPT_HASH }],
      tool: async () => { throw new Error("hive down"); },
    });
    const result = await drainWorkUnitEffects(db, { unitId: "unit-1", host: HOST, ports });
    const states = Object.fromEntries(result.effects.map((effect) => [effect.effect_id, effect.state]));
    expect(states).toEqual({ "e-complete": "succeeded", "e-f0": "failed_optional", "e-start": "failed_optional" });
    const done = await transitionWorkUnit(db, { unitId: "unit-1", expectedState: "PUBLISHING", unitFence: result.unit.fence, nextState: "DONE", patch: { kind: "finalize" } });
    expect(done.state).toBe("DONE");
  });
});
