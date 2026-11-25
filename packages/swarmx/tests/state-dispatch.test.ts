/**
 * Mission state + dispatch gate invariants (Task 4).
 *
 * Covers, end to end, on the fake V2 context (`tests/helpers.ts`):
 *   - strict cell-marker parsing and the read-only legacy mission validator;
 *   - WorkUnit actor-checked mission commands;
 *   - Task 13d3e: no split KV lifecycle state remains.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import swarmx from "../src/index";

import {
  DISPATCH_TOOL_NAME,
  extractCellMarker,
  gateBefore,
  settleAfter,
  type DispatchAfterEvent,
  type DispatchBeforeEvent,
} from "../src/dispatch";
import {
  createMissionState,
  createMissionStateStore,
  readMission,
  type LegacyMissionStateStore,
  type MissionStorageLike,
} from "../src/state";
import { DispatchGateError, type GateReason, type MissionState } from "../src/types";
import { createFakeContext, type FakeAgentInfo, type FakeContext } from "./helpers";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema, type WorkUnit } from "../src/workunit/schema";
import { assignCell, createMission, listUnits } from "../src/workunit/mission";
import {
  getWorkUnit,
  recordReviewIntent,
  insertReviewEffects,
  ReviewIntentConflictError,
  SubmissionConflictError,
  EffectReplayConflictError,
  RetryNotAllowedError,
} from "../src/workunit/store";
import {
  createMissionCommands,
  MissionActorError,
  ReviewReceiptRequiredError,
  ReviewPayloadError,
  reviewEffectPlan,
  type MissionActor,
} from "../src/workunit/commands";
import { createWorkUnitEffectPorts } from "../src/workunit/ports";
import { DefiniteEffectError, type WorkUnitEffectPorts } from "../src/workunit/effects";
import { CliError } from "../src/cli";
import { LocalToolError } from "../src/types";

const PROJECT = "adeo";
const SESSION = "ses-1";

const AGENTS: readonly FakeAgentInfo[] = [
  { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
  { id: "swarm/swarm-coordinator", name: "swarm-coordinator", mode: "primary", hidden: false, permissions: [] },
  { id: "swarm/swarm-worker", name: "swarm-worker", mode: "subagent", hidden: false, permissions: [] },
  { id: "internal-helper", name: "internal-helper", mode: "subagent", hidden: true, permissions: [] },
  { id: "development/typescript-pro", name: "ts-pro", mode: "subagent", hidden: false, permissions: [] },
  { id: "development/mode-all", name: "mode-all", mode: "all", hidden: false, permissions: [] },
];

interface Harness {
  readonly ctx: FakeContext;
  readonly store: LegacyMissionStateStore;
}

function setup(): Harness {
  const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
  const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
    projectID: PROJECT,
    listAgents: () => ctx.agent.list(),
  });
  return { ctx, store };
}

function cellMarker(cellID: string, epicID = "cell-epic"): string {
  return `<!-- swarmx:cell=${cellID}; epic=${epicID} -->`;
}

interface BeforeOptions {
  readonly id?: string;
  /** Target agent from the V2 subagent tool input. */
  readonly targetAgent?: string;
  /** Caller agent from ToolHooks.execute.before. */
  readonly callerAgent?: string;
  readonly cell?: string;
  readonly epic?: string;
  readonly tool?: string;
  readonly sessionID?: string;
  readonly prompt?: string;
  readonly description?: string;
  readonly input?: unknown;
}

function beforeEvent(options: BeforeOptions = {}): DispatchBeforeEvent {
  const cell = options.cell ?? "cell-a";
  const targetAgent = options.targetAgent ?? "development/typescript-pro";
  const input =
    options.input ??
    ({
      agent: targetAgent,
      prompt: options.prompt ?? `Implement the subtask.\n\n${cellMarker(cell, options.epic)}`,
      ...(options.description === undefined ? {} : { description: options.description }),
    } as Record<string, unknown>);
  return {
    tool: options.tool ?? DISPATCH_TOOL_NAME,
    sessionID: options.sessionID ?? SESSION,
    agent: options.callerAgent ?? "swarm/swarm-coordinator",
    messageID: "msg-1",
    id: options.id ?? "call-1",
    input,
  };
}

function afterEvent(
  status: "completed" | "error",
  options: BeforeOptions = {},
): DispatchAfterEvent {
  const base = beforeEvent(options);
  return status === "completed"
    ? { ...base, status: "completed", result: { ok: true } }
    : { ...base, status: "error", error: new Error("boom") };
}

/** Fixture: a legacy KV mission written straight into storage (the store itself is read-only). */
function baseMission(): MissionState {
  return createMissionState({ projectID: PROJECT, sessionID: SESSION, budget: { maxSpawns: 5, maxIterations: 3 } });
}

function seedMission(ctx: FakeContext, mission: MissionState): void {
  (ctx.storage as unknown as { map: Map<string, unknown> }).map.set(`mission:${PROJECT}:${SESSION}`, mission);
}

async function refuse(promise: Promise<unknown>, reason: GateReason): Promise<DispatchGateError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DispatchGateError);
    const gateError = error as DispatchGateError;
    expect(gateError.reason).toBe(reason);
    return gateError;
  }
  throw new Error(`expected a DispatchGateError with reason ${reason}`);
}

async function allow(promise: Promise<unknown>): Promise<void> {
  await promise;
}

describe("cell marker parsing", () => {
  test("accepts the exact marker form from prompt or description", () => {
    expect(extractCellMarker({ prompt: `x ${cellMarker("cell-1", "epic-9")}` })).toEqual({
      cellID: "cell-1",
      epicID: "epic-9",
    });
    expect(extractCellMarker({ description: cellMarker("cell-2") })).toEqual({
      cellID: "cell-2",
      epicID: "cell-epic",
    });
  });

  test("rejects near-miss and duplicated forms", () => {
    const rejected = [
      { prompt: "no marker at all" },
      { prompt: "<!--swarmx:cell=c1; epic=e1 -->" },
      { prompt: "<!--  swarmx:cell=c1; epic=e1 -->" },
      { prompt: "<!-- swarmx:cell=c1;epic=e1 -->" },
      { prompt: "<!-- swarmx:cell=c1; epic=e1-->" },
      { prompt: "<!-- swarmx:cell=c1 -->" },
      { prompt: `${cellMarker("c1")} ${cellMarker("c2")}` },
      { prompt: "" },
      {},
      null,
    ];
    for (const input of rejected) {
      expect(() => extractCellMarker(input)).toThrow(DispatchGateError);
    }
  });

});

describe("consolidation state", () => {
  const VALID = {
    epicID: "cell-epic",
    cellID: "cell-consolidate",
    status: "ready",
    prompt: "Merge the cells and verify.",
    createdAt: 1_700_000_000_000,
  } as const;

  /**
   * Persists a mission whose `consolidation` is forced to `value` and reads it
   * back. `undefined` therefore means "the validator rejected the document".
   */
  async function roundTrip(
    value: unknown,
  ): Promise<{ mission: MissionState | undefined; base: MissionState }> {
    const { ctx, store } = setup();
    const base = baseMission();
    seedMission(ctx, { ...base, consolidation: value } as unknown as MissionState);
    return { mission: await readMission(store, PROJECT, SESSION), base };
  }

  test("a mission without consolidation stays valid", async () => {
    const { ctx, store } = setup();
    seedMission(ctx, baseMission());

    const mission = await readMission(store, PROJECT, SESSION);

    expect(mission?.consolidation).toBeUndefined();
  });

  test("every consolidation status round-trips through the validator", async () => {
    for (const status of ["pending", "ready", "dispatched", "completed"] as const) {
      const { mission } = await roundTrip({ ...VALID, status });
      expect(mission?.consolidation).toEqual({ ...VALID, status });
    }
  });

  test("prompt is optional", async () => {
    const withoutPrompt = {
      epicID: VALID.epicID,
      cellID: VALID.cellID,
      status: VALID.status,
      createdAt: VALID.createdAt,
    };

    const { mission } = await roundTrip(withoutPrompt);

    expect(mission?.consolidation).toEqual(withoutPrompt);
  });

  test("an empty prompt is accepted (it is optional content, not an id)", async () => {
    const { mission } = await roundTrip({ ...VALID, prompt: "" });

    expect(mission?.consolidation?.prompt).toBe("");
  });

  test.each([
    ["a blank epicID", { ...VALID, epicID: "" }],
    ["a whitespace-only epicID", { ...VALID, epicID: "   " }],
    ["a non-string epicID", { ...VALID, epicID: 42 }],
    ["a blank cellID", { ...VALID, cellID: "" }],
    ["a whitespace-only cellID", { ...VALID, cellID: "\t\n" }],
    ["a missing cellID", { ...VALID, cellID: undefined }],
    ["an unknown status", { ...VALID, status: "merged" }],
    ["a non-string status", { ...VALID, status: 1 }],
    ["a missing status", { ...VALID, status: undefined }],
    ["a string createdAt", { ...VALID, createdAt: "1700000000000" }],
    ["a NaN createdAt", { ...VALID, createdAt: Number.NaN }],
    ["an Infinity createdAt", { ...VALID, createdAt: Number.POSITIVE_INFINITY }],
    ["a missing createdAt", { ...VALID, createdAt: undefined }],
    ["a non-string prompt", { ...VALID, prompt: ["merge"] }],
    ["null", null],
    ["an array", []],
    ["a bare string", "ready"],
  ])("rejects consolidation with %s", async (_label, value) => {
    const { mission } = await roundTrip(value);

    expect(mission).toBeUndefined();
  });
});

describe("plugin wiring", () => {
  test("buildLockReleaseRequiresMatchingOwnerToken", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const beforeHook = ctx.captures.toolHooks.get("execute.before")?.[0];
    const afterHook = ctx.captures.toolHooks.get("execute.after")?.[0];
    expect(beforeHook).toBeDefined();
    expect(afterHook).toBeDefined();

    const shellBefore = (id: string) => ({
      tool: "shell",
      sessionID: SESSION,
      agent: "build",
      messageID: `message-${id}`,
      id,
      input: { command: "bun run build" },
    });
    const shellAfter = (id: string) => ({
      ...shellBefore(id),
      status: "completed" as const,
      result: { output: "Bundled" },
    });

    await beforeHook?.(shellBefore("call-a"));
    await expect(beforeHook?.(shellBefore("call-b"))).rejects.toThrow();

    // A shell call that did not acquire the lock must not release call A's lock.
    await afterHook?.(shellAfter("call-b"));
    await expect(beforeHook?.(shellBefore("call-b"))).rejects.toThrow();

    await afterHook?.(shellAfter("call-a"));
    await expect(beforeHook?.(shellBefore("call-b"))).resolves.toBeUndefined();
    await afterHook?.(shellAfter("call-b"));
  });

});


describe("WorkUnit actor-checked mission commands", () => {
  const opened: DatabaseAdapter[] = [];
  const owner: MissionActor = { kind: "coordinator", sessionId: "coord" };
  const host = { hostInstanceId: "host-1", hostname: "box", pid: 1 };
  const policy = { total: 10, perCellIterations: 3, workerShare: null, version: 1 as const };

  async function rig(portsOverride?: Partial<WorkUnitEffectPorts>) {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    opened.push(db);
    await ensureWorkUnitSchema(db);
    const mission = await createMission(db, { project: "p", sessionId: "coord", missionId: "m", mode: "dev", budgetPolicy: policy });
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const closed = new Map<string, { status: string; completionOperationId: string | null }>();
    const ports: WorkUnitEffectPorts = {
      readHiveCell: async (_project, cellId) => closed.get(cellId) ?? { status: "in_progress" },
      runBackendTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "swarm_complete") closed.set(String(args.bead_id), { status: "closed", completionOperationId: String(args.operation_id) });
        return { success: true };
      },
      prepareConsolidation: async () => ({}),
      ...portsOverride,
    };
    const commands = createMissionCommands(db, { host, ports: () => ports });
    return { db, mission, commands, calls };
  }

  async function submitted(r: Awaited<ReturnType<typeof rig>>, cellId = "c1", evidence: Record<string, unknown> = { filesTouched: ["src/a.ts"], summary: "ok" }) {
    const reserved = await r.commands.reserve(owner, {
      project: "p", missionId: "m", workerAgent: "coder", callId: `call-${cellId}`, dispatchToken: `tok-${cellId}`,
      cellId, budgetCharge: 1, idemKey: `idem-${cellId}`, attemptNo: 1,
    });
    const bound = await r.commands.settleDispatch(owner, { unitId: reserved.id, unitFence: reserved.fence, outcome: { ok: true, workerSessionId: "w1", workerAgent: "coder" } });
    const unit = await r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: bound.id, evidence, diff: "diff" });
    return unit;
  }

  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close?.();
  });

  test("actor: non-owner coordinators and worker actors are rejected for coordinator commands", async () => {
    const r = await rig();
    const input = { project: "p", missionId: "m", workerAgent: "coder", callId: "c", dispatchToken: "t", cellId: "c1", budgetCharge: 1, idemKey: "i", attemptNo: 1 };
    await expect(r.commands.reserve({ kind: "coordinator", sessionId: "other" }, input)).rejects.toThrow(MissionActorError);
    await expect(r.commands.reserve({ kind: "worker", sessionId: "coord" }, input)).rejects.toThrow(MissionActorError);
    const unit = await r.commands.reserve(owner, input);
    await expect(r.commands.bindWorker({ kind: "coordinator", sessionId: "other" }, { unitId: unit.id, unitFence: unit.fence, workerSessionId: "w", workerAgent: "coder" })).rejects.toThrow(MissionActorError);
    await expect(r.commands.assignCell({ kind: "coordinator", sessionId: "other" }, { missionPk: r.mission.id, cellId: "x", agent: "coder" })).rejects.toThrow(MissionActorError);
    await expect(r.commands.releaseAssignment({ kind: "coordinator", sessionId: "other" }, { missionPk: r.mission.id, cellId: "x" })).rejects.toThrow(MissionActorError);
    await expect(r.commands.finish({ kind: "coordinator", sessionId: "other" }, { missionPk: r.mission.id })).rejects.toThrow(MissionActorError);
    await expect(r.commands.cancel({ kind: "worker", sessionId: "coord" }, { missionPk: r.mission.id })).rejects.toThrow(MissionActorError);
    expect(await listUnits(r.db, r.mission.id)).toHaveLength(1);
  });

  test("actor: dispatch failure is a fixed-purpose RESERVED to FAILED settlement", async () => {
    const r = await rig();
    const unit = await r.commands.reserve(owner, { project: "p", missionId: "m", workerAgent: "coder", callId: "c", dispatchToken: "t", cellId: "c1", budgetCharge: 1, idemKey: "i", attemptNo: 1 });
    const failed = await r.commands.settleDispatch(owner, { unitId: unit.id, unitFence: unit.fence, outcome: { ok: false, error: { message: "spawn failed" } } });
    expect(failed).toMatchObject({ state: "FAILED", fence: unit.fence + 1, error_json: JSON.stringify({ message: "spawn failed" }) });
  });

  test("actor: worker submit requires the bound worker session and persists canonical evidence", async () => {
    const r = await rig();
    const reserved = await r.commands.reserve(owner, { project: "p", missionId: "m", workerAgent: "coder", callId: "c", dispatchToken: "t", cellId: "c1", budgetCharge: 1, idemKey: "i", attemptNo: 1 });
    await expect(r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: reserved.id, evidence: {} })).rejects.toThrow();
    const bound = await r.commands.bindWorker(owner, { unitId: reserved.id, unitFence: reserved.fence, workerSessionId: "w1", workerAgent: "coder" });
    await expect(r.commands.submit({ kind: "worker", sessionId: "intruder" }, { unitId: bound.id, evidence: { b: 1 } })).rejects.toThrow(MissionActorError);
    await expect(r.commands.submit({ kind: "coordinator", sessionId: "coord" }, { unitId: bound.id, evidence: { b: 1 } })).rejects.toThrow(MissionActorError);
    const unit = await r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: bound.id, evidence: { b: 1, a: [2, { d: 1, c: 0 }] }, diff: "x" });
    expect(unit).toMatchObject({ state: "SUBMITTED", fence: bound.fence + 1, evidence_json: '{"a":[2,{"c":0,"d":1}],"b":1}' });
    expect(unit.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("submit replay: identical evidence returns the saved unit without a write; changed evidence conflicts", async () => {
    const r = await rig();
    const first = await submitted(r);
    const replay = await r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: first.id, evidence: { summary: "ok", filesTouched: ["src/a.ts"] }, diff: "diff" });
    expect(replay).toEqual(first);
    await expect(r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: first.id, evidence: { summary: "changed" }, diff: "diff" })).rejects.toThrow(SubmissionConflictError);
    await expect(r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: first.id, evidence: { summary: "ok", filesTouched: ["src/a.ts"] }, diff: "other" })).rejects.toThrow(SubmissionConflictError);
    await r.commands.review(owner, { projectPath: "/proj/p", unitId: first.id, status: "approved", summary: "done", receipt: { filesTouched: ["src/a.ts"], passed: true } });
    const later = await r.commands.submit({ kind: "worker", sessionId: "w1" }, { unitId: first.id, evidence: { summary: "ok", filesTouched: ["src/a.ts"] }, diff: "diff" });
    expect(later.state).toBe("DONE");
    expect(later).toEqual((await getWorkUnit(r.db, first.id)) as WorkUnit);
  });

  test("review approval requires a receipt for non-doc work and drains completion with fence reviewFence + 2", async () => {
    const r = await rig();
    const unit = await submitted(r);
    await expect(r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "approved", summary: "done" })).rejects.toThrow(ReviewReceiptRequiredError);
    await expect(r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "unverifiable", summary: "done" })).rejects.toThrow(ReviewReceiptRequiredError);
    await expect(r.commands.review({ kind: "coordinator", sessionId: "other" }, { projectPath: "/proj/p", unitId: unit.id, status: "approved", summary: "done", receipt: { filesTouched: [] } })).rejects.toThrow(MissionActorError);
    expect((await getWorkUnit(r.db, unit.id))?.state).toBe("SUBMITTED");
    const result = await r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "approved", summary: "done", receipt: { filesTouched: ["src/a.ts"], passed: true } });
    const reviewFence = unit.fence + 1;
    const effect = result.effects.find((e) => e.kind === "backend_complete");
    expect(effect).toMatchObject({ effect_id: `effect:${unit.id}:backend_complete`, unit_fence: reviewFence + 2, state: "succeeded", mandatory: 1 });
    expect(result.unit).toMatchObject({ state: "DONE", review_verdict: "approved", review_by: "coord" });
    expect(JSON.parse(result.unit.verification_receipt_json ?? "null")).toEqual({ filesTouched: ["src/a.ts"], passed: true });
    expect(r.calls).toEqual([{ name: "swarm_complete", args: {
      project_key: "/proj/p", bead_id: "c1", agent_name: "coder", summary: "done", operation_id: `op:${unit.id}:backend_complete`,
    } }]);
  });

  test("review approval rejects a missing completion summary before any write", async () => {
    const r = await rig();
    const unit = await submitted(r);
    await expect(r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "approved", receipt: { filesTouched: [] } })).rejects.toThrow(ReviewPayloadError);
    await expect(r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "approved", summary: " ", receipt: { filesTouched: [] } })).rejects.toThrow(ReviewPayloadError);
    expect(await getWorkUnit(r.db, unit.id)).toEqual(unit);
    expect((await r.db.query("SELECT effect_id FROM swarmx_effects")).rows).toEqual([]);
  });

  test("review unverifiable approves doc-only and empty-file work without a receipt", async () => {
    const r = await rig();
    const docs = await submitted(r, "c-doc", { filesTouched: ["README.md", "docs/guide.txt", "assets/logo.svg"] });
    expect((await r.commands.review(owner, { projectPath: "/proj/p", unitId: docs.id, status: "unverifiable", summary: "done" })).unit).toMatchObject({ state: "DONE", review_verdict: "unverifiable", verification_receipt_json: null });
    const empty = await submitted(r, "c-empty", { filesTouched: [] });
    expect((await r.commands.review(owner, { projectPath: "/proj/p", unitId: empty.id, status: "unverifiable", summary: "done" })).unit.state).toBe("DONE");
  });

  test("review needs_changes revokes the worker, drains feedback at reviewFence + 1, then CHANGES_REQUESTED", async () => {
    const order: string[] = [];
    let r!: Awaited<ReturnType<typeof rig>>;
    r = await rig({
      runBackendTool: async (name, args) => {
        const unit = (await listUnits(r.db, r.mission.id))[0];
        order.push(`${name}:${unit?.state}:${unit?.worker_session}`);
        r.calls.push({ name, args });
        return { success: true, status: "needs_changes" };
      },
    });
    const unit = await submitted(r);
    const result = await r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "needs_changes", feedback: ["fix it"] });
    expect(order).toEqual(["swarm_review_feedback:RETURNING:null"]);
    const reviewFence = unit.fence + 1;
    expect(result.effects).toEqual([expect.objectContaining({ effect_id: `effect:${unit.id}:backend_feedback`, unit_fence: reviewFence + 1, state: "succeeded" })]);
    expect(result.unit).toMatchObject({ state: "CHANGES_REQUESTED", worker_session: null, review_verdict: "needs_changes" });
    expect(r.calls[0]?.args).toEqual({
      project_key: "/proj/p", task_id: "c1", worker_id: "coder", status: "needs_changes", issues: '["fix it"]',
      operation_id: `op:${unit.id}:backend_feedback`,
    });
    await expect(r.commands.retry(owner, { priorUnitId: unit.id, workerAgent: "", callId: "c2", dispatchToken: "t2", budgetCharge: 1 })).rejects.toThrow(RetryNotAllowedError);
    const retried = await r.commands.retry(owner, { priorUnitId: unit.id, workerAgent: "coder", callId: "c2", dispatchToken: "t2", budgetCharge: 1 });
    expect(retried).toMatchObject({ state: "RESERVED", retry_of: unit.id, attempt_no: 2 });
  });

  test("review needs_changes stays RETURNING when the mandatory feedback effect is definitely rejected", async () => {
    const r = await rig({ runBackendTool: async () => { throw new DefiniteEffectError("nope"); } });
    const unit = await submitted(r);
    const result = await r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "needs_changes", feedback: ["fix"] });
    expect(result.unit.state).toBe("RETURNING");
    expect(result.effects[0]?.state).toBe("failed_mandatory");
    await expect(r.commands.retry(owner, { priorUnitId: unit.id, workerAgent: "coder", callId: "c2", dispatchToken: "t2", budgetCharge: 1 })).rejects.toThrow(RetryNotAllowedError);
  });

  test("review intent conflict: a different concurrent intent is rejected", async () => {
    const r = await rig();
    const unit = await submitted(r);
    const begun = await r.commands.beginReview(owner, { unitId: unit.id });
    const intent = { verdict: "approved", reviewer: "coord", receiptJson: '{"filesTouched":[]}', feedbackJson: null };
    await recordReviewIntent(r.db, { unitId: unit.id, reviewFence: begun.fence, intent });
    await recordReviewIntent(r.db, { unitId: unit.id, reviewFence: begun.fence, intent });
    await expect(recordReviewIntent(r.db, { unitId: unit.id, reviewFence: begun.fence, intent: { ...intent, verdict: "needs_changes", receiptJson: null, feedbackJson: '["x"]' } })).rejects.toThrow(ReviewIntentConflictError);
    await expect(r.commands.review(owner, { projectPath: "/proj/p", unitId: unit.id, status: "needs_changes", feedback: ["x"] })).rejects.toThrow(ReviewIntentConflictError);
  });

  test("review crash replay: intent-only and intent+effects states complete by exact replay", async () => {
    const r = await rig();
    const unit = await submitted(r);
    const input = { projectPath: "/proj/p", unitId: unit.id, status: "approved" as const, summary: "done", receipt: { filesTouched: ["src/a.ts"] } };
    const begun = await r.commands.beginReview(owner, { unitId: unit.id });
    const plan = reviewEffectPlan(begun, input);
    await recordReviewIntent(r.db, { unitId: unit.id, reviewFence: begun.fence, intent: plan.intent });
    await insertReviewEffects(r.db, { unitId: unit.id, reviewFence: begun.fence, effects: plan.effects });
    const effectRows = await r.db.query("SELECT effect_id, state, unit_fence FROM swarmx_effects");
    expect(effectRows.rows).toEqual([{ effect_id: `effect:${unit.id}:backend_complete`, state: "pending", unit_fence: begun.fence + 2 }]);
    expect(r.calls).toEqual([]);
    const replayed = await r.commands.review(owner, input);
    expect(replayed.unit.state).toBe("DONE");
    expect(r.calls).toHaveLength(1);
    const again = await r.commands.review(owner, input);
    expect(again.unit).toEqual(replayed.unit);
    expect(r.calls).toHaveLength(1);
    await expect(insertReviewEffects(r.db, { unitId: unit.id, reviewFence: begun.fence, effects: [{ ...plan.effects[0]!, requestJson: '{"other":1}' }] })).rejects.toThrow(EffectReplayConflictError);
  });

  test("review effects are never inserted before IN_REVIEW", async () => {
    const r = await rig();
    const unit = await submitted(r);
    const plan = reviewEffectPlan({ ...unit, state: "IN_REVIEW", fence: unit.fence + 1 }, { projectPath: "/proj/p", unitId: unit.id, status: "approved", summary: "done", receipt: {} });
    await expect(insertReviewEffects(r.db, { unitId: unit.id, reviewFence: unit.fence + 1, effects: plan.effects })).rejects.toThrow();
    expect((await r.db.query("SELECT effect_id FROM swarmx_effects")).rows).toEqual([]);
  });

  test("assignment: owner-fenced assign and release through commands", async () => {
    const r = await rig();
    await r.commands.assignCell(owner, { missionPk: r.mission.id, cellId: "c9", agent: "coder" });
    const released = await r.commands.releaseAssignment(owner, { missionPk: r.mission.id, cellId: "c9" });
    expect(released).toMatchObject({ state: "released", owner: null, agent: null });
  });

  test("finish and cancel close the mission with chained fences", async () => {
    const r = await rig();
    const finished = await r.commands.finish(owner, { missionPk: r.mission.id });
    expect(finished).toMatchObject({ state: "FINISHED", fence: 2 });
    const other = await createMission(r.db, { project: "p", sessionId: "coord", missionId: "m2", mode: "dev", budgetPolicy: policy });
    await r.commands.reserve(owner, { project: "p", missionId: "m2", workerAgent: "coder", callId: "cx", dispatchToken: "t", cellId: "cz", budgetCharge: 1, idemKey: "iz", attemptNo: 1 });
    const cancelled = await r.commands.cancel(owner, { missionPk: other.id });
    expect(cancelled.state).toBe("CANCELLED");
    expect((await listUnits(r.db, other.id))[0]?.state).toBe("CANCELLED");
  });
});

describe("WorkUnit effect ports", () => {
  test("effectPortsMapCompletionOperationId maps Hive completion identity and forwards exact args", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const ports = createWorkUnitEffectPorts({
      runTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "hive_cells") return [{ id: "c1", status: "closed", completion_operation_id: "op-1" }];
        return { success: true };
      },
    });
    expect(await ports.readHiveCell("/proj", "c1")).toEqual({ status: "closed", completionOperationId: "op-1" });
    const args = { project_key: "/proj", bead_id: "c1", operation_id: "op-1" };
    await ports.runBackendTool("swarm_complete", args);
    expect(calls[1]).toEqual({ name: "swarm_complete", args });
    expect(calls[1]?.args).toBe(args);
  });

  test("effectPortsMapCompletionOperationId returns null for a missing cell", async () => {
    const ports = createWorkUnitEffectPorts({ runTool: async () => [] });
    expect(await ports.readHiveCell("/proj", "c1")).toBeNull();
  });

  test("effectPortsClassifyDefiniteRejection only treats explicit rejections as definite", async () => {
    const throwing = (value: unknown) => createWorkUnitEffectPorts({ runTool: async () => { throw value; } });
    await expect(throwing(new DefiniteEffectError("x")).runBackendTool("swarm_complete", {})).rejects.toBeInstanceOf(DefiniteEffectError);
    await expect(throwing(new LocalToolError("swarm_complete", "invalid_input", "bad")).runBackendTool("swarm_complete", {})).rejects.toBeInstanceOf(DefiniteEffectError);
    for (const ambiguous of [new CliError("CliNonZero", "swarm_complete", "boom", 1), new Error("generic"), "thrown string", { success: false, error: "obj" }]) {
      const rejection = await throwing(ambiguous).runBackendTool("swarm_complete", {}).catch((error: unknown) => error);
      expect(rejection).not.toBeInstanceOf(DefiniteEffectError);
    }
    const feedback = (value: unknown) => createWorkUnitEffectPorts({ runTool: async () => value }).runBackendTool("swarm_review_feedback", {});
    await expect(feedback({ success: false, error: "denied" })).rejects.toBeInstanceOf(DefiniteEffectError);
    expect(await feedback({ success: true, status: "needs_changes" })).toEqual({ success: true, status: "needs_changes" });
    expect(await feedback({ success: false, error: "denied", extra: 1 })).toEqual({ success: false, error: "denied", extra: 1 });
    expect(await feedback({ success: false, error: 3 })).toEqual({ success: false, error: 3 });
  });
});

describe("Task 13d3e: split lifecycle state is removed", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

  test("raw: operational legacy helpers are no longer exported", async () => {
    const state = (await import("../src/state")) as Record<string, unknown>;
    for (const name of [
      "setBudget", "finishMission", "resetMission", "recordRetryCause", "setAssignment", "putAttempt",
      "acquireBuildLock", "releaseBuildLock", "bindWorkerAttemptSession", "withMissionLock", "legacyStoreOf",
      "maybePrepareConsolidation", "completeConsolidation", "audit", "reconcileMissionCounts",
    ]) {
      expect(state[name], name).toBeUndefined();
    }
    for (const name of ["createLegacyLifecycleStore", "createTombstoneGuardedStorage", "isLegacyLifecycleTombstoned", "legacyTombstoneKey"]) {
      expect(typeof state[name], name).toBe("function");
    }
  });

  test("raw: no lifecycle set/remove outside the migration tombstone and the guarded proxy", () => {
    const state = source("state.ts");
    expect(state.match(/storage\.(set|remove)\(/g) ?? []).toEqual(["storage.set("]);
    expect(state).toContain("await store.storage.set(legacyTombstoneKey(project, session), value)");
    for (const file of ["dispatch.ts", "index.ts", "catalog.ts"]) {
      expect(source(file), file).not.toMatch(/storage[!]?\.(set|remove)\(|legacyStoreOf|withMissionLock/);
    }
  });

  test("temporal: no in-process mission mutex, re-entry tracking or orphan grace in the store", () => {
    const state = source("state.ts");
    expect(state).not.toContain("AsyncLocalStorage");
    expect(state).not.toMatch(/new Map<string, Promise/);
    expect(state).not.toContain("orphanGraceMs");
    expect(source("dispatch.ts")).not.toMatch(/withMissionLock|putAttempt|AsyncLocalStorage/);
  });

  test("fallback: untombstoned legacy load is read-only (no orphan or count repair write)", async () => {
    const writes: string[] = [];
    const map = new Map<string, unknown>();
    const storage: MissionStorageLike = {
      get: async (key) => map.get(key),
      set: async (key, value) => { writes.push(`set:${key}`); map.set(key, value); },
      remove: async (key) => { writes.push(`remove:${key}`); map.delete(key); },
      scan: async ({ prefix }) => ({ entries: [...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    };
    map.set(`mission:${PROJECT}:${SESSION}`, {
      missionID: "m", projectID: PROJECT, sessionID: SESSION, active: true, mode: "dev",
      budget: { maxSpawns: 5, maxIterations: 3 }, counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    map.set(`attempt:${PROJECT}:c1`, { callID: "c1", missionID: "m", sessionID: SESSION, cellID: "x", agent: "a", status: "pending", ts: "2026-01-01T00:00:01.000Z" });
    const store = createMissionStateStore(storage, { projectID: PROJECT });
    const loaded = await store.load(PROJECT, SESSION);
    expect(loaded?.counts.spawns).toBe(0);
    await expect(store.save(loaded!)).rejects.toThrow(/read-only/);
    expect(writes).toEqual([]);
  });

  test("Dispatch: without WorkUnit the hooks are no-ops even with an active legacy KV mission", async () => {
    const { ctx, store } = setup();
    const map = (ctx.storage as unknown as { map: Map<string, unknown> }).map;
    map.set(`mission:${PROJECT}:${SESSION}`, {
      missionID: "m", projectID: PROJECT, sessionID: SESSION, active: true, mode: "dev",
      budget: { maxSpawns: 5, maxIterations: 3 }, counts: { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    map.set(`assignment:${PROJECT}:cell-a`, { cellID: "cell-a", agent: "development/typescript-pro", updatedAt: "x", sessionID: SESSION });
    const before = JSON.stringify([...map]);
    await gateBefore(store, beforeEvent({ id: "kv-call" }));
    await settleAfter(store, afterEvent("completed", { id: "kv-call" }));
    expect(JSON.stringify([...map])).toBe(before);
  });
});
