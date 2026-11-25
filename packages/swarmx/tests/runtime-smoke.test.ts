/**
 * Runtime smoke test for the swarmx V2 plugin (Tasks 1 + 8).
 *
 * Exercises the real registration surface against a fake V2 context — no model,
 * no network and no real OpenCode runtime. Guards:
 *   - default export is a `Plugin.define` object whose `id` is "swarmx";
 *   - `setup(fakeCtx)` resolves without throwing and registers a tool transform
 *     plus a compaction hook;
 *   - the transform exposes exactly the 83 catalogued tools and is replayable;
 *   - backend/deprecated/local execution paths behave as declared;
 *   - `swarm_set_budget` → `execute.before` (gate) → `execute.after` (settle)
 *     keeps exact counters and is idempotent per `Tool.CallID`;
 *   - every hook is a strict no-op outside an active mission;
 *   - the compaction hook pushes one factual `{type:"text"}` part and never
 *     assigns `event.result`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";

import swarmx, { createSwarmxPlugin, setupWorkUnitRuntime, type WorkUnitRuntime } from "../src/index";
import { findToolSpec, listToolNames } from "../src/catalog";

/** Raw pre-WorkUnit pending-completion key; native lifecycle must never write it. */
function rawPendingCompletionKey(projectID: string, taskID: string): string {
  return ["pending-completion:", projectID, taskID].map(encodeURIComponent).join(":");
}
import { extractCellMarker } from "../src/dispatch";
import {
  createMissionStateStore,
  getAttempt,
  listAttempts,
  readMission,
  resolveAssignment,
  setAssignment,
  setBudget,
  type MissionStorageLike,
} from "../src/state";
import { UnsupportedToolError, type CellMarker } from "../src/types";
import { createMission, getMission, listUnits } from "../src/workunit/mission";
import type { MissionActor } from "../src/workunit/commands";
import { AssignmentMismatchError, BudgetGateError, getWorkUnit, MissionNotDrainedError } from "../src/workunit/store";
import { acquireWorkUnitLock, CLEANUP_LOCK_STALE_MS, cleanupLockName } from "../src/workunit/locks";
import {
  createFakeContext,
  type FakeAgentInfo,
  type FakeCompactionEvent,
  type FakeContext,
  type FakePermissionAssertion,
  type FakeSkillInfo,
  type FakeToolInfo,
} from "./helpers";

const PROJECT = "adeo";
const SESSION = "ses-1";

/**
 * Project-relative fixture paths. Resolved from this test file so the fixture
 * stays valid whatever cwd `bun test` is launched from.
 */
const SWARMX_FILE = relative(process.cwd(), fileURLToPath(new URL("../src/catalog.ts", import.meta.url)));
const SWARMX_STATE_FILE = relative(process.cwd(), fileURLToPath(new URL("../src/state.ts", import.meta.url)));

interface BeforePayload {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
}

type AfterPayload = BeforePayload &
  (
    | { status: "completed"; result: unknown }
    | { status: "error"; error: unknown }
  );

/**
 * Extracting the real registration callback from OpenCode's plugin context
 * pins the execute hook fields to the installed @opencode/plugin contract.
 * The callback input is a union of before/after payloads, whose shared id
 * type proves call-ID symmetry; `input` remains unknown until narrowed.
 */
type OpenCodeExecutePayload = Parameters<
  Parameters<Plugin.Context["tool"]["hook"]>[1]
>[0];

type Assert<T extends true> = T;
type OpenCodeExecutePayloadContract = Assert<
  OpenCodeExecutePayload extends { readonly id: string; readonly input: unknown } ? true : false
>;

function readOpenCodeShellPayload<T extends { readonly id: string; readonly input: unknown }>(payload: T): {
  readonly id: string;
  readonly command?: string;
} {
  const input = payload.input;
  const command =
    typeof input === "object" && input !== null && "command" in input &&
    typeof input.command === "string"
      ? input.command
      : undefined;
  return { id: payload.id, ...(command === undefined ? {} : { command }) };
}

interface RigOptions {
  readonly agents?: readonly FakeAgentInfo[];
  readonly skills?: readonly FakeSkillInfo[];
  readonly permissionAssert?: (input: FakePermissionAssertion) => Promise<void>;
  readonly projectPath?: string;
  readonly workerCell?: CellMarker;
  readonly workerSessionID?: string;
  readonly workerParentSessionID?: string;
  readonly rootSessionIDs?: readonly string[];
  /** Payload returned by the fake CLI runner for every backend tool. */
  readonly payload?: unknown;
  readonly payloadFor?: (name: string, args: Record<string, unknown>) => unknown;
  readonly workerProtocol?: string;
  readonly workUnit?: WorkUnitRuntime;
}

interface Rig {
  readonly ctx: FakeContext;
  readonly tools: Map<string, FakeToolInfo>;
  readonly runCalls: { name: string; args: Record<string, unknown> }[];
  readonly runEnvironments: { name: string; env?: Readonly<Record<string, string>> }[];
  readonly runWorkingDirectories: { name: string; cwd?: string }[];
  readonly before: (payload: BeforePayload) => Promise<void>;
  readonly after: (payload: AfterPayload) => Promise<void>;
  readonly compaction: (event: FakeCompactionEvent) => Promise<void>;
  readonly bindWorkerSession: (sessionID: string, marker: CellMarker, parentSessionID?: string) => void;
}

/**
 * Boots `createSwarmxPlugin` on a fake context with a fake CLI runner and
 * replays the registered transform to obtain an executable tool registry.
 */
async function createRig(options: RigOptions = {}): Promise<Rig> {
  const ctx = createFakeContext({
    agents: options.agents,
    skills: options.skills,
    permissionAssert: options.permissionAssert,
    projectId: PROJECT,
    projectPath: options.projectPath,
  });
  const runCalls: { name: string; args: Record<string, unknown> }[] = [];
  const runEnvironments: { name: string; env?: Readonly<Record<string, string>> }[] = [];
  const runWorkingDirectories: { name: string; cwd?: string }[] = [];
  const defaultWorkerSessionID = options.workerSessionID ?? "ses-worker";
  const workerCells = new Map<string, CellMarker>();
  const workerParents = new Map<string, string | null>();
  if (options.workerCell !== undefined) workerCells.set(defaultWorkerSessionID, options.workerCell);
  workerParents.set(defaultWorkerSessionID, options.workerParentSessionID ?? SESSION);
  for (const rootSessionID of options.rootSessionIDs ?? []) {
    workerParents.set(rootSessionID, null);
  }
  const payload = options.payload ?? { ok: true };
  const workerSessionID = options.workerSessionID ?? "ses-worker";

  const plugin = createSwarmxPlugin({
    runtime: {
      runTool: async (
        name,
        args,
        runOptions?: {
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string>>;
        },
      ) => {
        runCalls.push({ name, args });
        runEnvironments.push({ name, ...(runOptions?.env === undefined ? {} : { env: runOptions.env }) });
        runWorkingDirectories.push({ name, ...(runOptions?.cwd === undefined ? {} : { cwd: runOptions.cwd }) });
        return options.payloadFor?.(name, args) ?? payload;
      },
      resolveWorkerCell: async (sessionID) => workerCells.get(sessionID) ?? options.workerCell,
      resolveWorkerParentSession: async (sessionID) => workerParents.get(sessionID),
      // Explicit backend choice: legacy-branch rigs pass `workUnit: undefined` on purpose.
      workUnit: options.workUnit,
      ...(options.workerProtocol === undefined ? {} : { workerProtocol: options.workerProtocol }),
    },
  });
  await plugin.setup(ctx as unknown as Plugin.Context);

  const transform = ctx.captures.toolTransforms[0];
  expect(transform).toBeDefined();
  const editor = ctx.createEditor();
  transform(editor);
  const tools = new Map(editor.list().map((tool) => [tool.name, tool]));

  const beforeHook = ctx.captures.toolHooks.get("execute.before")?.[0];
  const afterHook = ctx.captures.toolHooks.get("execute.after")?.[0];
  const compactionHook = ctx.captures.sessionHooks.get("compaction")?.[0];
  expect(beforeHook).toBeDefined();
  expect(afterHook).toBeDefined();
  expect(compactionHook).toBeDefined();

  return {
    ctx,
    tools,
    runCalls,
    runEnvironments,
    runWorkingDirectories,
    before: async (event) => {
      await beforeHook?.(event);
    },
    after: async (event) => {
      await afterHook?.(event);
    },
    compaction: async (event) => {
      await compactionHook?.(event);
    },
    bindWorkerSession: (sessionID, marker, parentSessionID) => {
      workerCells.set(sessionID, marker);
      if (parentSessionID !== undefined) workerParents.set(sessionID, parentSessionID);
    },
  };
}

const openedWorkUnitDatabases: DatabaseAdapter[] = [];

afterEach(async () => {
  for (const db of openedWorkUnitDatabases.splice(0)) await db.close?.();
});

async function createNativeMission(options: {
  readonly sessionID?: string;
  readonly total?: number;
  readonly perCellIterations?: number;
} = {}): Promise<{ readonly runtime: WorkUnitRuntime; readonly missionPk: string }> {
  const sessionID = options.sessionID ?? SESSION;
  const db = await createLibSQLAdapter({ url: ":memory:" });
  openedWorkUnitDatabases.push(db);
  const runtime = await setupWorkUnitRuntime(db, {
    projectID: PROJECT,
    host: { hostInstanceId: "runtime-smoke", hostname: "test-host", pid: 1 },
  });
  const mission = await createMission(db, {
    project: PROJECT,
    sessionId: sessionID,
    missionId: `work-${sessionID}`,
    mode: "dev",
    budgetPolicy: {
      total: options.total ?? 3,
      perCellIterations: options.perCellIterations ?? 3,
      workerShare: null,
      version: 1,
    },
  });
  return { runtime, missionPk: mission.id };
}

const nativeCoordinator: MissionActor = { kind: "coordinator", sessionId: SESSION };

function missionStore(ctx: FakeContext) {
  return createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
    projectID: PROJECT,
  });
}

async function dispatchWorker(
  rig: Rig,
  cellID = "cell-a",
  callID = "call-worker-dispatch",
  workerSessionID = "ses-worker",
) {
  const store = missionStore(rig.ctx);
  if ((await readMission(store, PROJECT, SESSION)) === undefined) {
    await setBudget(store, {
      projectID: PROJECT,
      sessionID: SESSION,
      mode: "dev",
      maxSpawns: 3,
      maxIterations: 3,
      workerShare: 1,
    });
  }
  await setAssignment(store, PROJECT, cellID, "swarm/swarm-worker");
  const payload = workerDispatchPayload(cellID, callID);
  await rig.before(payload);
  const prompt = (payload.input as { prompt: string }).prompt;
  const marker = extractCellMarker({ prompt });
  rig.bindWorkerSession(workerSessionID, marker, SESSION);
  return marker;
}

function cellMarker(cellID: string, epicID = "epic-1"): string {
  return `<!-- swarmx:cell=${cellID}; epic=${epicID} -->`;
}

function toolContext(
  agent = "swarm/swarm-coordinator",
  id = "call-local-tool",
  sessionID = SESSION,
): { sessionID: string; agent: string; messageID: string; id: string } {
  return { sessionID, agent, messageID: "msg-local-tool", id };
}

function workerToolContext(
  agent = "swarm/swarm-worker",
  id = "call-worker-tool",
  sessionID = "ses-worker",
): { sessionID: string; agent: string; messageID: string; id: string } {
  return toolContext(agent, id, sessionID);
}

function beforePayload(overrides: Partial<BeforePayload> = {}): BeforePayload {
  return {
    tool: "subagent",
    sessionID: SESSION,
    agent: "swarm/swarm-coordinator",
    messageID: "msg-1",
    id: "call-1",
    input: {
      agent: "development/typescript-pro",
      prompt: `Implement the subtask.\n\n${cellMarker("cell-a")}`,
    },
    ...overrides,
  };
}

function workerDispatchPayload(cellID = "cell-a", id = "call-worker-dispatch"): BeforePayload {
  return {
    ...beforePayload({ id }),
    input: {
      agent: "swarm/swarm-worker",
      prompt: `Implement the assigned cell.\n\n${cellMarker(cellID)}`,
    },
  };
}

/**
 * Successful `swarm_complete` payload: the backend runs the verification gate
 * and returns its receipt, which swarmx requires before it can approve.
 */
function completionVerification(): Record<string, unknown> {
  return {
    success: true,
    verification_gate: {
      passed: true,
      summary: "All verification steps passed",
      steps: [
        { name: "typecheck", passed: true, skipped: false },
        { name: "tests", passed: true, skipped: false },
      ],
    },
  };
}

/** Builds the `swarm_review` payload shape swarmx accepts for one scoped diff. */
function scopedReviewPayload(
  files: readonly string[],
  diff: string,
): Record<string, unknown> {
  return {
    review_prompt: [
      "## Files Modified",
      ...files.map((file) => `- \`${file}\``),
      "",
      "## Code Changes",
      "```diff",
      diff,
      "```",
      "",
      "## Review Criteria",
    ].join("\n"),
    context: { files_touched: files },
  };
}

async function stageCellReview(
  rig: Rig,
  input: {
    readonly projectPath: string;
    readonly file: string;
    readonly cellID: string;
    readonly label: string;
  },
): Promise<void> {
  await dispatchWorker(rig, input.cellID, `call-dispatch-${input.label}`);
  const completion = rig.tools.get("swarm_complete");
  const review = rig.tools.get("swarm_review");
  if (completion === undefined || review === undefined) throw new Error("completion tools are not registered");
  await completion.execute(
    {
      project_key: input.projectPath,
      agent_name: "swarm-worker",
      bead_id: input.cellID,
      summary: "Completed the assigned work.",
      start_time: 1,
      files_touched: [input.file],
    },
    workerToolContext("swarm/swarm-worker", `call-completion-${input.label}`),
  );
  await review.execute(
    {
      project_key: input.projectPath,
      epic_id: "epic-1",
      task_id: input.cellID,
      files_touched: [input.file],
    },
    toolContext("swarm/swarm-coordinator", `call-review-${input.label}`),
  );
}

function reviewReceiptStorageKey(rig: Rig): string | undefined {
  return [...rig.ctx.storage.map.keys()].find((key) => key.startsWith("review-receipt%3A"));
}

function afterPayload(
  status: "completed" | "error",
  overrides: Partial<BeforePayload> = {},
): AfterPayload {
  const base = beforePayload(overrides);
  return status === "completed"
    ? { ...base, status: "completed", result: { ok: true } }
    : { ...base, status: "error", error: new Error("boom") };
}

const GATE_AGENTS: readonly FakeAgentInfo[] = [
  { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
  {
    id: "swarm/swarm-coordinator",
    name: "swarm-coordinator",
    mode: "primary",
    hidden: false,
    permissions: ["skills_execute", "swarm_worktree_merge"].map((action) => ({
      action,
      resource: "*",
      effect: "deny" as const,
    })),
  },
  {
    id: "swarm/swarm-worker",
    name: "swarm-worker",
    mode: "subagent",
    hidden: false,
    permissions: [
      "swarm_set_budget",
      "swarm_set_agent",
      "swarm_resolve_agent",
      "swarm_finish",
      "swarm_review_feedback",
      "swarm_review",
      "hive_close",
      "hive_start",
      "hive_sync",
      "swarmmail_release_all",
      "swarmmail_release_agent",
      "skills_execute",
      "swarm_worktree_merge",
    ].map((action) => ({ action, resource: "*", effect: "deny" as const })),
  },
  { id: "development/typescript-pro", name: "ts-pro", mode: "subagent", hidden: false, permissions: [] },
];

describe("swarmx plugin registration", () => {
  test("real execute hook payload accepts its call ID and narrowed shell command", () => {
    const payload = beforePayload({
      tool: "shell",
      id: "call-real-hook-shape",
      input: { command: "bun run build" },
    });

    expect(readOpenCodeShellPayload(payload)).toEqual({
      id: "call-real-hook-shape",
      command: "bun run build",
    });
  });

  test("default export declares id 'swarmx'", () => {
    expect(swarmx.id).toBe("swarmx");
    expect(typeof swarmx.setup).toBe("function");
  });

  test("setup registers a tool transform and a compaction hook without throwing", async () => {
    const ctx = createFakeContext();

    // The fake context mirrors the V2 Context structurally; the cast is the only
    // bridge because the plugin requires the nominal @opencode/plugin.Context.
    await swarmx.setup(ctx as unknown as Plugin.Context);

    expect(ctx.captures.toolTransforms.length).toBeGreaterThanOrEqual(1);
    expect(ctx.captures.sessionHooks.get("compaction")?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("registered tool transform is replayable and registers every catalogued tool", async () => {
    const ctx = createFakeContext();
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const [transform] = ctx.captures.toolTransforms;
    const editor = ctx.createEditor();
    const expected = listToolNames();

    expect(expected).toHaveLength(89);
    expect(() => transform(editor)).not.toThrow();
    expect(editor.list()).toHaveLength(89);
    expect(editor.list().map((tool) => tool.name).sort()).toEqual(expected);
    // The editor derives ids from the effective name (the real SDK never
    // receives an id); a single `undefined` key would collapse the registry.
    expect(editor.list().map((tool) => tool.id).sort()).toEqual(expected);

    // Replaying the exact same transform on the same editor must not duplicate.
    expect(() => transform(editor)).not.toThrow();
    expect(editor.list()).toHaveLength(89);
    expect(editor.list().map((tool) => tool.name).sort()).toEqual(expected);
  });

  test("registered compaction hook is a no-op that leaves the event untouched", async () => {
    const ctx = createFakeContext();
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const [hook] = ctx.captures.sessionHooks.get("compaction") ?? [];
    expect(hook).toBeDefined();

    const event = ctx.createCompactionEvent();
    const systemLength = event.system.length;
    await hook?.(event);

    expect(event.system).toHaveLength(systemLength);
    expect(event.result).toBeUndefined();
  });
});

describe("catalogue execution paths (fake runner, no model)", () => {
  test("backend tool relays the CLI payload to the caller", async () => {
    const backendPayload = { outcome: "ready", cell: "cell-1" };
    const rig = await createRig({ payload: backendPayload });

    const tool = rig.tools.get("hive_ready");
    expect(tool).toBeDefined();
    const spec = findToolSpec("hive_ready");
    expect(spec?.kind).toBe("backend");

    const result = await tool?.execute({}, toolContext());

    expect(result?.output).toEqual(backendPayload);
    expect(rig.runCalls).toEqual([{ name: "hive_ready", args: {} }]);
  });

  test("deprecated tool rejects with unsupported_tool and its replacement", async () => {
    const rig = await createRig();
    const tool = rig.tools.get("swarm_get_strategy_insights");
    expect(tool).toBeDefined();

    const error = await tool?.execute({ task: "plan" }, {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedToolError);
    const unsupported = error as UnsupportedToolError;
    expect(unsupported.message).toContain("unsupported_tool:swarm_get_strategy_insights");
    expect(unsupported.reason).toContain("swarm_insights");
    expect(rig.runCalls).toHaveLength(0);
  });

  test("local tool runs its real in-process handler", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    const tool = rig.tools.get("swarm_roster");
    expect(tool).toBeDefined();

    const result = await tool?.execute({}, toolContext());
    const output = result?.output as { total: number; count: number; agents: { id: string }[] };

    expect(output.total).toBe(GATE_AGENTS.length);
    expect(output.agents.map((agent) => agent.id)).toEqual([
      "development/typescript-pro",
      "swarm/swarm-worker",
    ]);
    expect(rig.runCalls).toHaveLength(0);
  });
});

describe("mission gate → settle sequence", () => {
  test("WorkUnit dispatch creates a bound unit without marking it DONE", async () => {
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-a",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const payload = workerDispatchPayload("cell-a", "call-native-success");

    await rig.before(payload);
    const marker = extractCellMarker(payload.input);
    expect(marker.dispatchToken).toMatch(/^[a-f0-9-]{36}$/);
    await rig.after({ ...payload, status: "completed", result: { sessionID: "ses-native-worker" } });

    const units = await listUnits(native.runtime.db, native.missionPk);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      state: "BOUND",
      call_id: "call-native-success",
      cell_id: "cell-a",
      dispatch_token: marker.dispatchToken,
      worker_agent: "swarm/swarm-worker",
      worker_session: "ses-native-worker",
      idem_key: "dispatch:adeo:ses-1:call-native-success",
      attempt_no: 1,
      budget_charge: 1,
    });
    expect(units[0]?.state).not.toBe("DONE");
    expect(await listAttempts(missionStore(rig.ctx), PROJECT, SESSION)).toEqual([]);
  });

  test("WorkUnit dispatch failure settles the reservation as FAILED", async () => {
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-failed",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const payload = workerDispatchPayload("cell-failed", "call-native-failure");

    await rig.before(payload);
    await rig.after({ ...payload, status: "error", error: new Error("spawn failed") });

    expect(await listUnits(native.runtime.db, native.missionPk)).toMatchObject([
      { state: "FAILED", call_id: "call-native-failure" },
    ]);
  });

  test("WorkUnit duplicate dispatch is idempotent by call ID", async () => {
    const native = await createNativeMission({ total: 1 });
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-replay",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const payload = workerDispatchPayload("cell-replay", "call-native-replay");

    await rig.before(payload);
    const token = extractCellMarker(payload.input).dispatchToken;
    await rig.before(payload);

    const units = await listUnits(native.runtime.db, native.missionPk);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      state: "RESERVED",
      call_id: "call-native-replay",
      dispatch_token: token,
      attempt_no: 1,
      budget_charge: 1,
      idem_key: "dispatch:adeo:ses-1:call-native-replay",
    });
    expect(units.reduce((sum, unit) => sum + (unit.budget_charge ?? 0), 0)).toBe(1);
  });

  test("concurrent native bind returns the same bound unit for the same worker", async () => {
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-race",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    await rig.before(workerDispatchPayload("cell-race", "call-race"));
    const [unit] = await listUnits(native.runtime.db, native.missionPk);
    const args = { unitId: unit!.id, unitFence: unit!.fence };
    const [a, b] = await Promise.all([
      native.runtime.commands.settleDispatch(nativeCoordinator, {
        ...args,
        outcome: { ok: true, workerSessionId: "ses-race", workerAgent: "swarm/swarm-worker" },
      }),
      native.runtime.commands.bindWorker(nativeCoordinator, {
        ...args, workerSessionId: "ses-race", workerAgent: "swarm/swarm-worker",
      }),
    ]);
    expect(a).toMatchObject({ id: unit!.id, state: "BOUND", worker_session: "ses-race" });
    expect(b).toMatchObject({ id: unit!.id, state: "BOUND", worker_session: "ses-race" });
    await expect(native.runtime.commands.bindWorker(nativeCoordinator, {
      ...args, workerSessionId: "ses-other", workerAgent: "swarm/swarm-worker",
    })).rejects.toThrow();
  });

  test("WorkUnit assignment and budget gates reject invalid dispatches", async () => {
    const native = await createNativeMission({ total: 1 });
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-a",
      agent: "development/typescript-pro",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    await expect(rig.before(workerDispatchPayload("cell-a", "call-wrong-assignment")))
      .rejects.toBeInstanceOf(AssignmentMismatchError);

    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-a",
      agent: "swarm/swarm-worker",
    });
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-b",
      agent: "swarm/swarm-worker",
    });
    await rig.before(workerDispatchPayload("cell-a", "call-within-budget"));
    await expect(rig.before(workerDispatchPayload("cell-b", "call-over-budget")))
      .rejects.toBeInstanceOf(BudgetGateError);
    expect(await listUnits(native.runtime.db, native.missionPk)).toHaveLength(1);
  });

  test("WorkUnit dispatch rejects a caller that is not the coordinator", async () => {
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-a",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const payload = workerDispatchPayload("cell-a", "call-wrong-coordinator");

    await expect(rig.before({ ...payload, agent: "swarm/swarm-worker" }))
      .rejects.toThrow(/only a coordinator primary/);
    expect(await listUnits(native.runtime.db, native.missionPk)).toEqual([]);
  });

  test("WorkUnit worker-session binding uses the actor-checked command", async () => {
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-bind",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({
      agents: GATE_AGENTS,
      workUnit: native.runtime,
      workerCell: { cellID: "cell-bind", epicID: "epic-1" },
    });
    const payload = workerDispatchPayload("cell-bind", "call-native-bind");
    await rig.before(payload);
    const marker = extractCellMarker(payload.input);
    rig.bindWorkerSession("ses-native-bound", marker, SESSION);

    await expect(rig.ctx.permission.assert({
      sessionID: "ses-native-bound",
      agent: "swarm/swarm-worker",
      source: { type: "tool", messageID: "msg-native-bind", id: "call-native-bind-edit" },
      action: "edit",
      resources: ["src/handler.ts"],
    })).resolves.toBeUndefined();

    expect(await listUnits(native.runtime.db, native.missionPk)).toMatchObject([
      { state: "BOUND", worker_session: "ses-native-bound", worker_agent: "swarm/swarm-worker" },
    ]);
  });

  test("WorkUnit assignment tools use actor-checked mission commands", async () => {
    const native = await createNativeMission();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });

    await rig.tools.get("swarm_set_agent")?.execute(
      { bead_id: "cell-set", agent: "swarm-worker" },
      toolContext(),
    );
    await rig.tools.get("swarm_resolve_agent")?.execute(
      { apply: true, cells: [{ bead_id: "cell-resolve", title: "TypeScript API implementation", files: ["src/handler.ts"] }] },
      toolContext(),
    );

    const assignments = await native.runtime.db.query(
      "SELECT cell_id, agent, owner, state FROM swarmx_legacy_assignments ORDER BY cell_id",
    );
    expect(assignments.rows).toEqual([
      { cell_id: "cell-resolve", agent: "development/typescript-pro", owner: SESSION, state: "assigned" },
      { cell_id: "cell-set", agent: "swarm/swarm-worker", owner: SESSION, state: "assigned" },
    ]);
    expect(await resolveAssignment(missionStore(rig.ctx), PROJECT, "cell-set")).toBeUndefined();
  });

  test("read-only follow-up dispatch does not consume a cell iteration", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await dispatchWorker(rig, "cell-a", "call-dispatch-first");
    const followup = workerDispatchPayload("cell-a", "call-followup");
    const input = followup.input as { prompt: string };
    input.prompt += "\n\n<!-- swarmx:followup=read-only -->";
    await rig.before(followup);
    const mission = await readMission(missionStore(rig.ctx), PROJECT, SESSION);
    expect(mission?.counts.spawns).toBe(2);
    expect(mission?.counts.attemptsByCell["cell-a"]).toBe(1);
  });

  test("worker permissions block review approval and direct Hive closure tools", async () => {
    const cases = [
      "swarm_review_feedback",
      "swarm_review",
      "hive_close",
      "hive_sync",
    ] as const;

    for (const [index, name] of cases.entries()) {
      const rig = await createRig({ agents: GATE_AGENTS });
      const tool = rig.tools.get(name);
      expect(tool).toBeDefined();

      await expect(
        tool?.execute({}, workerToolContext("swarm/swarm-worker", `call-forbidden-${index}`)),
      ).rejects.toThrow(`permission denied: ${name}`);
      expect(rig.runCalls).toHaveLength(0);
    }
  });

  test("subagents cannot skip review or verification in swarm_complete", async () => {
    for (const [index, bypass] of ["skip_review", "skip_verification"].entries()) {
      const rig = await createRig({ agents: GATE_AGENTS });
      const tool = rig.tools.get("swarm_complete");
      expect(tool).toBeDefined();

      await expect(
        tool?.execute(
          {
            project_key: process.cwd(),
            agent_name: "swarm-worker",
            bead_id: "cell-a",
            summary: "Completed the assigned work.",
            start_time: 1,
            files_touched: [SWARMX_FILE],
            [bypass]: true,
          },
          workerToolContext("swarm/swarm-worker", `call-bypass-${index}`),
        ),
      ).rejects.toThrow("swarmx never allows review or verification bypasses");
      expect(rig.runCalls).toHaveLength(0);
    }
  });

  test("non-boolean completion overrides are rejected before reaching the backend", async () => {
    for (const [index, value] of ["true", 1, null].entries()) {
      for (const bypass of ["skip_review", "skip_verification"] as const) {
        const rig = await createRig({ agents: GATE_AGENTS });
        const tool = rig.tools.get("swarm_complete");
        expect(tool).toBeDefined();

        await expect(
          tool?.execute(
            {
              project_key: process.cwd(),
              agent_name: "swarm-worker",
              bead_id: "cell-a",
              summary: "Completed the assigned work.",
              start_time: 1,
              files_touched: [SWARMX_FILE],
              [bypass]: value,
            },
            workerToolContext("swarm/swarm-worker", `call-bypass-coerced-${index}`),
          ),
        ).rejects.toThrow("swarmx never allows review or verification bypasses");
        expect(rig.runCalls).toHaveLength(0);
      }
    }
  });

  test("swarmx rejects completion overrides from all callers", async () => {
    for (const [index, agent] of ["build", "swarm/swarm-coordinator"].entries()) {
      const rig = await createRig({ agents: GATE_AGENTS });
      const tool = rig.tools.get("swarm_complete");
      expect(tool).toBeDefined();

      await expect(
        tool?.execute(
          {
            project_key: process.cwd(),
            agent_name: agent,
            bead_id: "cell-a",
            summary: "Completed the assigned work.",
            start_time: 1,
            files_touched: [SWARMX_FILE],
            skip_review: true,
          },
          toolContext(agent, `call-primary-bypass-${index}`),
        ),
      ).rejects.toThrow("swarmx never allows review or verification bypasses");
      expect(rig.runCalls).toHaveLength(0);
    }
  });

  test("mode-all specialists cannot call coordinator-only mission tools", async () => {
    const agents = GATE_AGENTS.map((agent) =>
      agent.id === "development/typescript-pro" ? { ...agent, mode: "all" as const, permissions: [] } : agent,
    );
    const cases = [
      { tool: "swarm_set_budget", input: { mode: "audit" } },
      { tool: "swarm_set_agent", input: { bead_id: "cell-a", agent: "development/typescript-pro" } },
      { tool: "swarm_finish", input: { reason: "done" } },
      { tool: "swarm_resolve_agent", input: {} },
      { tool: "swarm_review", input: {} },
      { tool: "swarm_review_feedback", input: {} },
      { tool: "hive_create", input: {} },
      { tool: "hive_create_epic", input: {} },
      { tool: "hive_close", input: {} },
      { tool: "hive_start", input: {} },
      { tool: "hive_sync", input: {} },
      { tool: "swarmmail_release_all", input: {} },
      { tool: "swarmmail_release_agent", input: { agent_name: "swarm-worker" } },
      { tool: "swarm_worktree_cleanup", input: { project_path: process.cwd(), cleanup_all: true } },
    ] as const;

    for (const [index, entry] of cases.entries()) {
      const rig = await createRig({ agents });
      const tool = rig.tools.get(entry.tool);
      await expect(
        tool?.execute(entry.input, toolContext("development/typescript-pro", `call-mode-all-${index}`)),
      ).rejects.toThrow("only the canonical swarm coordinator may use this tool");
      expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toBeUndefined();
      expect(rig.runCalls).toHaveLength(0);
    }
  });

  test("coordinator and dispatched specialists cannot run script or worktree-merge escapes", async () => {
    for (const [index, name] of ["skills_execute", "swarm_worktree_merge"].entries()) {
      const coordinatorRig = await createRig({ agents: GATE_AGENTS });
      await expect(
        coordinatorRig.tools.get(name)?.execute({}, toolContext("swarm/swarm-coordinator", `call-coordinator-${index}`)),
      ).rejects.toThrow(`permission denied: ${name}`);
      expect(coordinatorRig.runCalls).toHaveLength(0);

      const modeAllAgents = GATE_AGENTS.map((agent) =>
        agent.id === "development/typescript-pro" ? { ...agent, mode: "all" as const, permissions: [] } : agent,
      );
      const specialistRig = await createRig({ agents: modeAllAgents });
      await expect(
        specialistRig.tools.get(name)?.execute(
          {},
          toolContext("development/typescript-pro", `call-specialist-${index}`),
        ),
      ).rejects.toThrow("subagents may not run skill scripts, merge worktrees, mutate shared skills, or delete shared memory");
      expect(specialistRig.runCalls).toHaveLength(0);
    }
  });

  test("subagents cannot mutate shared skills or delete hivemind records", async () => {
    for (const [index, name] of [
      "skills_create",
      "skills_init",
      "skills_update",
      "skills_delete",
      "skills_add_script",
      "hivemind_remove",
    ].entries()) {
      const modeAllAgents = GATE_AGENTS.map((agent) =>
        agent.id === "development/typescript-pro" ? { ...agent, mode: "all" as const, permissions: [] } : agent,
      );
      const rig = await createRig({ agents: modeAllAgents });
      await expect(
        rig.tools.get(name)?.execute({}, toolContext("development/typescript-pro", `call-forbidden-global-${index}`)),
      ).rejects.toThrow("subagents may not run skill scripts, merge worktrees, mutate shared skills, or delete shared memory");
      expect(rig.runCalls).toHaveLength(0);
    }
  });

  test("subagents cannot invoke the swarm CLI directly through shell", async () => {
    const agents = [
      ...GATE_AGENTS,
      { id: "development/mode-all", name: "mode-all", mode: "all" as const, hidden: false, permissions: [] },
    ];
    const rig = await createRig({ agents });
    const callers = ["swarm/swarm-worker", "development/typescript-pro", "development/mode-all"];
    const commands = [
      "swarm tool swarm_review_feedback --json {}",
      "/usr/bin/swarm tool swarm_review_feedback --json {}",
      "npx swarm tool swarm_review_feedback --json {}",
      "pnpm exec swarm tool swarm_review_feedback --json {}",
      "sw''arm tool swarm_review_feedback --json {}",
      "sw\\arm tool swarm_review_feedback --json {}",
      "/bin/sh -c 'swarm tool swarm_review_feedback --json {}'",
      "bash -c \"sw''arm tool swarm_review_feedback --json {}\"",
      "sw\\\narm tool swarm_review_feedback --json {}",
      "sw${EMPTY}arm tool swarm_review_feedback --json {}",
      "swarm${IFS}tool hive_ready --json '{}'",
      "$'swarm' tool swarm_review_feedback --json {}",
      "$'sw\\x61rm' tool swarm_review_feedback --json {}",
      "$'\\163warm' tool swarm_review_feedback --json {}",
      "$'\\U00000073warm' tool swarm_review_feedback --json {}",
      "/usr/bin/swar* tool swarm_review_feedback --json {}",
      "sw=sw; arm=arm; \"$sw$arm\" tool hive_close --json '{}'",
      "swarm t{o..o}ol hive_close --json '{}'",
      "SWARM=swarm; \"$SWARM\" tool swarm_review_feedback --json {}",
      "$(printf 'swarm') tool swarm_review_feedback --json {}",
      "swarm $(printf '%s' t o o l) hive_close --json '{}'",
      "python -c 'subprocess.run([\"swarm\", \"tool\", \"swarm_review_feedback\"])'",
      "bun /usr/lib/node_modules/opencode-swarm-plugin/dist/bin/swarm.js tool swarm_review_feedback --json {}",
      "function x(){ swarm \"$@\"; }; x tool swarm_review_feedback --json '{}'",
    ];
    let index = 0;
    for (const agent of callers) {
      for (const command of commands) {
        const denied = await rig.ctx.permission
          .assert({
            sessionID: SESSION,
            agent,
            source: { type: "tool", messageID: "msg-shell", id: `call-shell-${index++}` },
            action: "shell",
            resources: [command],
          })
          .then(
            () => false,
            () => true,
          );
        if (!denied) throw new Error(`shell permission allowed direct CLI syntax: ${command}`);
      }
    }

    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-unresolved-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-unresolved-worker", id: "call-unresolved-edit" },
        action: "edit",
        resources: ["src/handler.ts"],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked, unbound, or not owned by this session/);
  });

  test("first worker mutation binds the dispatch capability before swarmmail_init", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-first-mutation");

    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-first-mutation", id: "call-first-shell" },
        action: "shell",
        resources: ["git status --short"],
      }),
    ).resolves.toBeUndefined();

    const attempt = await getAttempt(missionStore(rig.ctx), PROJECT, "call-dispatch-first-mutation");
    expect(attempt?.workerSessionID).toBe("ses-worker");
  });

  test("a sibling session cannot steal a capability bound by first mutation", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    const marker = await dispatchWorker(rig, "cell-a", "call-dispatch-lazy-owner");
    await rig.ctx.permission.assert({
      sessionID: "ses-worker",
      agent: "swarm/swarm-worker",
      source: { type: "tool", messageID: "msg-lazy-owner", id: "call-lazy-owner-shell" },
      action: "shell",
      resources: ["git status --short"],
    });
    rig.bindWorkerSession("ses-sibling", marker, SESSION);

    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-sibling",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-sibling", id: "call-sibling-edit" },
        action: "edit",
        resources: ["src/handler.ts"],
      }),
    ).rejects.toThrow(/not_owner/);
    const attempt = await getAttempt(missionStore(rig.ctx), PROJECT, "call-dispatch-lazy-owner");
    expect(attempt?.workerSessionID).toBe("ses-worker");
  });

  test("concurrent first mutations bind the capability to exactly one session", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    const marker = await dispatchWorker(rig, "cell-a", "call-dispatch-race");
    rig.bindWorkerSession("ses-worker-a", marker, SESSION);
    rig.bindWorkerSession("ses-worker-b", marker, SESSION);
    const results = await Promise.allSettled([
      rig.ctx.permission.assert({
        sessionID: "ses-worker-a",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-race-a", id: "call-race-a" },
        action: "shell",
        resources: ["git status --short"],
      }),
      rig.ctx.permission.assert({
        sessionID: "ses-worker-b",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-race-b", id: "call-race-b" },
        action: "shell",
        resources: ["git status --short"],
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results[0]?.status === "fulfilled" ? "ses-worker-a" : "ses-worker-b";
    const attempt = await getAttempt(missionStore(rig.ctx), PROJECT, "call-dispatch-race");
    expect(attempt?.workerSessionID).toBe(winner);
  });

  test("concurrent build commands are serialized per project", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    const first = {
      ...beforePayload({ id: "call-build-a" }),
      tool: "shell",
      input: { command: "./mvnw test" },
    };
    const second = {
      ...beforePayload({ id: "call-build-b" }),
      tool: "shell",
      input: { command: "./mvnw test" },
    };
    await rig.before(first);
    await expect(rig.before({ ...second, sessionID: "ses-other-coordinator" })).rejects.toThrow(
      /another build|build.*progress/,
    );
    await rig.after({ ...first, status: "completed", result: {} });
    await expect(rig.before({ ...second, sessionID: "ses-other-coordinator" })).resolves.toBeUndefined();
    await rig.after({ ...second, sessionID: "ses-other-coordinator", status: "completed", result: {} });
  });

  test("root mode-all sessions keep native write access", async () => {
    const agents = [
      ...GATE_AGENTS,
      { id: "development/mode-all", name: "mode-all", mode: "all" as const, hidden: false, permissions: [] },
    ];
    const rig = await createRig({ agents, rootSessionIDs: ["ses-root"] });

    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-root",
        agent: "development/mode-all",
        source: { type: "tool", messageID: "msg-root-mode-all", id: "call-root-edit" },
        action: "edit",
        resources: ["src/handler.ts"],
      }),
    ).resolves.toBeUndefined();
  });

  test("root worker sessions still require a dispatch capability", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      rootSessionIDs: ["ses-root-worker"],
    });

    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-root-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-root-worker", id: "call-root-worker-edit" },
        action: "edit",
        resources: ["src/handler.ts"],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked, unbound, or not owned by this session/);
  });

  test("completion submission is bound to the actual dispatched worker session", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath: process.cwd(),
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    const marker = await dispatchWorker(rig, "cell-a", "call-dispatch-session-binding");
    rig.bindWorkerSession("ses-forged-worker", marker);

    await expect(
      rig.tools.get("swarm_complete")?.execute(
        {
          project_key: process.cwd(),
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          summary: "Forged session submission.",
          start_time: 1,
          files_touched: [SWARMX_FILE],
        },
        {
          sessionID: "ses-forged-worker",
          agent: "swarm/swarm-worker",
          messageID: "msg-forged-worker",
          id: "call-forged-completion",
        },
      ),
    ).rejects.toThrow(/not bound to this dispatched worker session/);
  });

  test("coordinator cannot cleanup a task worktree while its worker attempt is active", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({ agents: GATE_AGENTS, projectPath });
    await dispatchWorker(rig, "cell-a", "call-dispatch-live-worktree");

    await expect(
      rig.tools.get("swarm_worktree_cleanup")?.execute(
        { project_path: projectPath, task_id: "cell-a", cleanup_all: false },
        toolContext(),
      ),
    ).rejects.toThrow(/unrevoked worker attempt/);
    expect(rig.runCalls).toHaveLength(0);
  });

  test("cleanup releases its claim when the backend fails", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payloadFor: (name) => {
        if (name === "swarm_worktree_cleanup") throw new Error("cleanup backend boom");
        return { ok: true };
      },
    });

    await expect(
      rig.tools.get("swarm_worktree_cleanup")?.execute(
        { project_path: projectPath, task_id: "cell-a" },
        toolContext(),
      ),
    ).rejects.toThrow(/cleanup backend boom/);
    expect(await rig.ctx.storage.get("cleanup-claim:adeo")).toBeUndefined();
  });

  test("native cleanup holds a SQL lock that blocks dispatch until release", async () => {
    const projectPath = await realpath(process.cwd());
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-cleanup-lock",
      agent: "swarm/swarm-worker",
    });
    let announceBackend!: () => void;
    let finishBackend!: () => void;
    const backendStarted = new Promise<void>((resolve) => { announceBackend = resolve; });
    const backendGate = new Promise<void>((resolve) => { finishBackend = resolve; });
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workUnit: native.runtime,
      payloadFor: async (name) => {
        if (name === "swarm_worktree_cleanup") {
          announceBackend();
          await backendGate;
        }
        return { ok: true };
      },
    });

    const cleanup = rig.tools.get("swarm_worktree_cleanup")?.execute(
      { project_path: projectPath, task_id: "cell-cleanup-lock" },
      toolContext(),
    );
    await backendStarted;
    expect((await native.runtime.db.query("SELECT name FROM swarmx_locks WHERE name = ?", [cleanupLockName(PROJECT)])).rows)
      .toEqual([{ name: "cleanup:adeo" }]);
    expect(rig.ctx.storage.map.has("cleanup-claim:adeo")).toBe(false);
    await expect(rig.tools.get("swarm_worktree_cleanup")?.execute(
      { project_path: projectPath, task_id: "cell-cleanup-lock" },
      toolContext("swarm/swarm-coordinator", "call-contending-cleanup"),
    )).rejects.toThrow(/cleanup.*progress|cleanup.*already in progress/i);

    await expect(rig.before(workerDispatchPayload("cell-cleanup-lock", "call-blocked-by-cleanup")))
      .rejects.toThrow(/cleanup.*progress|cleanup_in_progress/i);
    finishBackend();
    await cleanup;
    expect((await native.runtime.db.query("SELECT name FROM swarmx_locks WHERE name = ?", [cleanupLockName(PROJECT)])).rows)
      .toEqual([]);
    await expect(rig.before(workerDispatchPayload("cell-cleanup-lock", "call-after-cleanup"))).resolves.toBeUndefined();
  });

  test("native dispatch ignores an expired SQL cleanup lock and cleanup never touches KV", async () => {
    const native = await createNativeMission();
    await native.runtime.commands.assignCell(nativeCoordinator, {
      missionPk: native.missionPk,
      cellId: "cell-expired-cleanup",
      agent: "swarm/swarm-worker",
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    await rig.ctx.storage.set("cleanup-claim:adeo", { taskID: "*", at: Date.now() });
    await acquireWorkUnitLock(native.runtime.db, {
      name: cleanupLockName(PROJECT),
      token: "expired-cleanup",
      ownerSession: SESSION,
      now: 0,
      staleAfterMs: CLEANUP_LOCK_STALE_MS,
    });

    await expect(rig.before(workerDispatchPayload("cell-expired-cleanup", "call-after-lock-expiry")))
      .resolves.toBeUndefined();
    expect(await rig.ctx.storage.get("cleanup-claim:adeo")).toEqual({ taskID: "*", at: expect.any(Number) });
  });

  test("a stale native cleanup owner cannot release its replacement lock", async () => {
    const projectPath = await realpath(process.cwd());
    const native = await createNativeMission();
    let announceBackend!: () => void;
    let finishBackend!: () => void;
    const backendStarted = new Promise<void>((resolve) => { announceBackend = resolve; });
    const backendGate = new Promise<void>((resolve) => { finishBackend = resolve; });
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workUnit: native.runtime,
      payloadFor: async (name) => {
        if (name === "swarm_worktree_cleanup") {
          announceBackend();
          await backendGate;
        }
        return { ok: true };
      },
    });
    const cleanup = rig.tools.get("swarm_worktree_cleanup")?.execute(
      { project_path: projectPath, task_id: "cell-stale-owner" },
      toolContext(),
    );
    await backendStarted;
    await native.runtime.db.query("UPDATE swarmx_locks SET acquired_at = 0 WHERE name = ?", [cleanupLockName(PROJECT)]);
    const replacement = await acquireWorkUnitLock(native.runtime.db, {
      name: cleanupLockName(PROJECT),
      token: "replacement-owner",
      ownerSession: "replacement-session",
      now: CLEANUP_LOCK_STALE_MS,
      staleAfterMs: CLEANUP_LOCK_STALE_MS,
    });
    expect(replacement).toEqual({ acquired: true, fence: 2 });

    finishBackend();
    await cleanup;
    expect((await native.runtime.db.query("SELECT token, fence FROM swarmx_locks WHERE name = ?", [cleanupLockName(PROJECT)])).rows)
      .toEqual([{ token: "replacement-owner", fence: 2 }]);
  });

  test("native reset cancels through WorkUnit and preserves terminal unit history", async () => {
    const native = await createNativeMission();
    const reserved = await native.runtime.commands.reserve(nativeCoordinator, {
      project: PROJECT,
      missionId: `work-${SESSION}`,
      workerAgent: "swarm/swarm-worker",
      callId: "call-reset-history",
      dispatchToken: "token-reset-history",
      cellId: "cell-reset-history",
      budgetCharge: 1,
      idemKey: "reset-history",
      attemptNo: 1,
    });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });

    await rig.tools.get("swarm_reset")?.execute({}, toolContext());

    expect(await getMission(native.runtime.db, PROJECT, SESSION)).toMatchObject({ state: "CANCELLED" });
    expect(await listUnits(native.runtime.db, native.missionPk)).toMatchObject([
      { id: reserved.id, state: "CANCELLED", cell_id: "cell-reset-history" },
    ]);
    expect(await native.runtime.db.query("SELECT COUNT(id) AS count FROM swarmx_missions WHERE id = ?", [native.missionPk]))
      .toMatchObject({ rows: [{ count: 1 }] });
  });

  test("native reset refuses a non-owner session and leaves the mission open", async () => {
    const native = await createNativeMission();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });

    await expect(rig.tools.get("swarm_reset")?.execute({}, toolContext("swarm/swarm-coordinator", "call-wrong-reset-owner", "ses-other")))
      .rejects.toThrow(/native mission is not available|does not own mission/i);
    expect(await getMission(native.runtime.db, PROJECT, SESSION)).toMatchObject({ state: "OPEN" });
  });

  test("native reset leaves the mission closing when a mandatory effect has not drained", async () => {
    const native = await createNativeMission();
    const reserved = await native.runtime.commands.reserve(nativeCoordinator, {
      project: PROJECT,
      missionId: `work-${SESSION}`,
      workerAgent: "swarm/swarm-worker",
      callId: "call-reset-drain",
      dispatchToken: "token-reset-drain",
      cellId: "cell-reset-drain",
      budgetCharge: 1,
      idemKey: "reset-drain",
      attemptNo: 1,
    });
    const bound = await native.runtime.commands.settleDispatch(nativeCoordinator, {
      unitId: reserved.id,
      unitFence: reserved.fence,
      outcome: { ok: true, workerSessionId: "ses-reset-worker", workerAgent: "swarm/swarm-worker" },
    });
    const submitted = await native.runtime.commands.submit(
      { kind: "worker", sessionId: "ses-reset-worker" },
      { unitId: bound.id, evidence: { filesTouched: ["src/a.ts"], summary: "done" }, diff: "diff" },
    );
    await native.runtime.commands.review(nativeCoordinator, {
      unitId: submitted.id,
      status: "approved",
      summary: "done",
      receipt: { filesTouched: ["src/a.ts"], passed: true },
      projectPath: process.cwd(),
    });
    expect(await getWorkUnit(native.runtime.db, reserved.id)).toMatchObject({ state: "PUBLISHING" });
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });

    await expect(rig.tools.get("swarm_reset")?.execute({}, toolContext())).rejects.toBeInstanceOf(MissionNotDrainedError);

    expect(await getMission(native.runtime.db, PROJECT, SESSION)).toMatchObject({ state: "CLOSING", close_intent: "cancel" });
    expect(await getWorkUnit(native.runtime.db, reserved.id)).toMatchObject({ state: "PUBLISHING" });
  });

  test("an inactive mission with unrevoked worker attempts cannot cleanup its worktrees", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({ agents: GATE_AGENTS, projectPath });
    await dispatchWorker(rig, "cell-a", "call-dispatch-unsettled-cleanup");
    const store = missionStore(rig.ctx);
    const inactiveMission = await readMission(store, PROJECT, SESSION);
    expect(inactiveMission).toBeDefined();
    if (inactiveMission === undefined) throw new Error("test mission was not created");
    inactiveMission.active = false;
    await store.save(inactiveMission);

    await expect(
      rig.tools.get("swarm_worktree_cleanup")?.execute(
        { project_path: projectPath, task_id: "cell-a", cleanup_all: false },
        toolContext(),
      ),
    ).rejects.toThrow(/has an unrevoked worker attempt/);
    await expect(
      rig.tools.get("swarm_worktree_cleanup")?.execute(
        { project_path: projectPath, cleanup_all: true },
        toolContext(),
      ),
    ).rejects.toThrow(/unrevoked worker attempts/);
    expect(rig.runCalls).toHaveLength(0);
  });

  test("swarm_complete rejects an empty summary before reaching the backend", async () => {
    const rig = await createRig({ agents: GATE_AGENTS, projectPath: process.cwd() });

    await expect(
      rig.tools.get("swarm_complete")?.execute(
        {
          project_key: process.cwd(),
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          summary: "  ",
          start_time: 1,
          files_touched: [SWARMX_FILE],
        },
        workerToolContext("swarm/swarm-worker", "call-empty-summary"),
      ),
    ).rejects.toThrow(/summary must be a non-empty string/);
    expect(rig.runCalls).toHaveLength(0);
  });

  test("swarm_review rejects broad, directory, traversal, and foreign-project scopes", async () => {
    const projectPath = await realpath(process.cwd());
    const parentPath = await realpath(`${projectPath}/..`);
    const rig = await createRig({ agents: GATE_AGENTS, projectPath });
    const tool = rig.tools.get("swarm_review");
    expect(tool).toBeDefined();

    const invalidScopes = [
      { project_key: projectPath, files_touched: ["."] },
      { project_key: projectPath, files_touched: ["../AGENTS.md"] },
      { project_key: projectPath, files_touched: ["plugins/swarmx"] },
      { project_key: parentPath, files_touched: [SWARMX_FILE] },
    ];
    for (const [index, scope] of invalidScopes.entries()) {
      await expect(
        tool?.execute(
          { ...scope, epic_id: "epic-1", task_id: "cell-a" },
          toolContext("swarm/swarm-coordinator", `call-invalid-scope-${index}`),
        ),
      ).rejects.toThrow(/files_touched|project_key/);
    }
    expect(rig.runCalls).toHaveLength(0);
  });

  test("swarm_review rejects non-canonical, .opencode1, and mixed-separator project keys", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({ agents: GATE_AGENTS, projectPath });
    const tool = rig.tools.get("swarm_review");
    expect(tool).toBeDefined();

    const rejectedKeys = [
      `${projectPath}/`,
      `${projectPath}/.`,
      `${projectPath}/opencode/..`,
      `${projectPath}/.opencode1`,
    ];
    for (const [index, projectKey] of rejectedKeys.entries()) {
      await expect(
        tool?.execute(
          {
            project_key: projectKey,
            epic_id: "epic-1",
            task_id: "cell-a",
            files_touched: [SWARMX_FILE],
          },
          toolContext("swarm/swarm-coordinator", `call-non-canonical-${index}`),
        ),
      ).rejects.toThrow(/project_key/);
    }
    await expect(
      tool?.execute(
        {
          project_key: projectPath.replace("/", "\\"),
          epic_id: "epic-1",
          task_id: "cell-a",
          files_touched: [SWARMX_FILE],
        },
        toolContext("swarm/swarm-coordinator", "call-mixed-separators"),
      ),
    ).rejects.toThrow(/project_key/);
    await expect(
      tool?.execute(
        {
          project_key: `${projectPath}/.opencode1`,
          epic_id: "epic-1",
          task_id: "cell-a",
          files_touched: [SWARMX_FILE],
        },
        toolContext("swarm/swarm-coordinator", "call-stale-copy"),
      ),
    ).rejects.toThrow(/opencode1/);
    expect(rig.runCalls).toHaveLength(0);
  });

  test.skip("concurrent review decisions on one cell are serialized", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) =>
        name === "swarm_review"
          ? {
              review_prompt: [
                "## Files Modified",
                `- \`${file}\``,
                "",
                "## Code Changes",
                "```diff",
                `diff --git a/${file} b/${file}`,
                "@@ -1 +1 @@",
                "-old",
                "+new",
                "```",
                "",
                "## Review Criteria",
              ].join("\n"),
              context: { files_touched: [file] },
            }
          : name === "swarm_complete"
            ? completionVerification()
            : { success: true },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-concurrent-review");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed the assigned work.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-pending-concurrent-review"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext(),
    );
    const feedback = rig.tools.get("swarm_review_feedback");
    const results = await Promise.allSettled([
      feedback?.execute(
        {
          project_key: projectPath,
          task_id: "cell-a",
          worker_id: "swarm/swarm-worker",
          status: "approved",
          summary: "Approve.",
        },
        toolContext("swarm/swarm-coordinator", "call-concurrent-approved"),
      ),
      feedback?.execute(
        {
          project_key: projectPath,
          task_id: "cell-a",
          worker_id: "swarm/swarm-worker",
          status: "needs_changes",
          summary: "Request changes.",
          issues: "[]",
        },
        toolContext("swarm/swarm-coordinator", "call-concurrent-needs-changes"),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rig.runCalls.filter((call) => call.name === "swarm_review_feedback")).toHaveLength(1);
    expect(rig.runCalls.filter((call) => call.name === "swarm_complete")).toHaveLength(1);
  });

  test("swarm_preflight reports a dirty working tree and accepts an explicit audit", async () => {
    const projectPath = await realpath(await mkdtemp(join(tmpdir(), "swarmx-preflight-dirty-")));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: projectPath });
      await writeFile(join(projectPath, "existing-change.txt"), "audit me\n");
      const rig = await createRig({ agents: GATE_AGENTS, projectPath });
      const preflight = rig.tools.get("swarm_preflight");
      expect(preflight).toBeDefined();

      const dirty = await preflight?.execute({}, toolContext());
      expect(dirty?.output).toMatchObject({
        working_tree: { clean: false, untracked_files: ["existing-change.txt"] },
      });
      const dirtyCheck = (dirty?.output as { checks?: Array<{ name: string; ok: boolean }> }).checks?.find(
        (check) => check.name === "working tree",
      );
      expect(dirtyCheck?.ok).toBe(false);

      const audited = await preflight?.execute(
        { allow_dirty: true, dirty_reason: "Existing changes audited before retry." },
        toolContext("swarm/swarm-coordinator", "call-preflight-audited"),
      );
      const auditedCheck = (audited?.output as { checks?: Array<{ name: string; ok: boolean }> }).checks?.find(
        (check) => check.name === "working tree",
      );
      expect(auditedCheck?.ok).toBe(true);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  async function createReviewReceiptRig(
    reviewPayload: unknown,
    filesTouched: string[],
    projectPath: string,
  ) {
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") return reviewPayload;
        if (name === "swarm_complete") return completionVerification();
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-review-receipt");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed review receipt scenario.",
        start_time: 1,
        files_touched: filesTouched,
      },
      workerToolContext("swarm/swarm-worker", "call-completion-review-receipt"),
    );
    try {
      const review = await rig.tools.get("swarm_review")?.execute(
        { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: filesTouched },
        toolContext("swarm/swarm-coordinator", "call-review-receipt"),
      );
      return { rig, review, error: undefined };
    } catch (error) {
      return { rig, review: undefined, error };
    }
  }

  test("generated subtask prompts include the worker protocol from the V2 skill catalog", async () => {
    const rig = await createRig({
      skills: [
        {
          id: "swarm-worker-protocol",
          name: "Swarm worker protocol",
          description: "Use when dispatched as a swarm worker",
          path: "/fake/project/.opencode/skills/swarm-worker-protocol/SKILL.md",
          content: "WORKER_PROTOCOL_FROM_ACTIVE_SKILL",
        },
      ],
    });
    const tool = rig.tools.get("swarm_subtask_prompt");
    expect(tool).toBeDefined();

    const result = await tool?.execute(
      {
        agent_name: "development/typescript-pro",
        bead_id: "cell-a",
        epic_id: "epic-1",
        subtask_title: "Implement the endpoint",
        subtask_description: "Add the handler.",
        files: ["src/handler.ts"],
      },
      toolContext(),
    );

    const prompt = String(result?.content);
    expect(prompt).toContain("WORKER_PROTOCOL_FROM_ACTIVE_SKILL");
    expect(prompt.indexOf("Files:")).toBeLessThan(prompt.indexOf("WORKER_PROTOCOL_FROM_ACTIVE_SKILL"));
    expect(prompt.endsWith("WORKER_PROTOCOL_FROM_ACTIVE_SKILL")).toBe(true);
  });

  test("generated subtask prompts fail closed when the worker protocol skill is missing", async () => {
    const rig = await createRig({ skills: [], workerProtocol: "" });
    const tool = rig.tools.get("swarm_subtask_prompt");
    expect(tool).toBeDefined();

    const result = await tool?.execute(
      {
        agent_name: "development/typescript-pro",
        bead_id: "cell-a",
        epic_id: "epic-1",
        subtask_title: "Implement the endpoint",
        subtask_description: "Add the handler.",
        files: ["src/handler.ts"],
      },
      toolContext(),
    );

    expect(result?.content).toContain("Load the swarm-worker-protocol skill before work");
    expect(result?.content).toContain("stop and report the blocker");
  });

  test("generated subtask prompts fail closed when the worker protocol content is blank", async () => {
    for (const content of ["", " \n\t "]) {
      const rig = await createRig({
        skills: [
          {
            id: "swarm-worker-protocol",
            name: "Swarm worker protocol",
            description: "Use when dispatched as a swarm worker",
            path: "/fake/project/.opencode/skills/swarm-worker-protocol/SKILL.md",
            content,
          },
        ],
      });
      const result = await rig.tools.get("swarm_subtask_prompt")?.execute(
        {
          agent_name: "development/typescript-pro",
          bead_id: "cell-a",
          epic_id: "epic-1",
          subtask_title: "Implement the endpoint",
          subtask_description: "Add the handler.",
          files: ["src/handler.ts"],
        },
        toolContext(),
      );

      expect(result?.content).toContain("Load the swarm-worker-protocol skill before work");
      expect(result?.content).toContain("stop and report the blocker");
    }
  });

  test("execute.before is a no-op on subagent when no mission is active", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    const size = rig.ctx.storage.map.size;

    await rig.before(beforePayload());
    await rig.after(afterPayload("completed"));

    expect(rig.ctx.storage.map.size).toBe(size);
    expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toBeUndefined();
  });

  test("compaction is a strict no-op without an active mission", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });

    const event = rig.ctx.createCompactionEvent({ sessionID: SESSION });
    await rig.compaction(event);

    expect(event.system).toHaveLength(1);
    expect(event.result).toBeUndefined();
  });
});


describe("WorkUnit runtime setup (additive)", () => {
  test("setup order: host identity -> schema -> recovery -> adapter/commands, with no tombstone or migration", async () => {
    const { createLibSQLAdapter } = await import("swarm-mail");
    const { setupWorkUnitRuntime } = await import("../src/index");
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      const steps: string[] = [];
      const legacyReads: string[] = [];
      const workUnit = await setupWorkUnitRuntime(db, {
        host: { hostInstanceId: "h", hostname: "box", pid: 42 },
        isProcessAlive: () => false,
        trace: (step) => steps.push(step),
        projectID: PROJECT,
        legacyReader: {
          getMission: async () => { legacyReads.push("get"); return undefined; },
          listMissions: async () => { legacyReads.push("list"); return []; },
        },
      });
      expect(steps).toEqual(["host", "schema", "recovery", "adapter", "commands"]);
      expect(workUnit.recovery).toEqual({ recovered: 0, foreignHostCandidates: [] });
      expect(workUnit.host).toEqual({ hostInstanceId: "h", hostname: "box", pid: 42 });
      expect(await workUnit.store.list()).toEqual([]);
      expect(legacyReads).toEqual(["list"]);
      const missions = await db.query("SELECT COUNT(id) AS n FROM swarmx_missions");
      expect(Number((missions.rows[0] as { n: unknown }).n)).toBe(0);
      const ports = workUnit.createEffectPorts({ runTool: async () => ({ success: true }) });
      expect(typeof ports.runBackendTool).toBe("function");
    } finally {
      await db.close?.();
    }
  });

  test("setup runs the optional legacy migration between schema and recovery", async () => {
    const { createLibSQLAdapter } = await import("swarm-mail");
    const { setupWorkUnitRuntime } = await import("../src/index");
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      const steps: string[] = [];
      const empty = async () => [];
      const legacyStore = {
        listMissions: async () => { steps.push("legacy-read"); return []; },
        getMission: async () => undefined,
        listAttempts: async () => { steps.push("legacy-read"); return []; },
        listAssignments: empty,
        listPendingCompletions: empty,
        listReviewReceipts: empty,
        getBuildLock: async () => undefined,
        getCleanupClaim: async () => undefined,
        setTombstone: async () => undefined,
      };
      await setupWorkUnitRuntime(db, {
        host: { hostInstanceId: "h", hostname: "box", pid: 42 },
        isProcessAlive: () => false,
        trace: (step) => steps.push(step),
        projectID: PROJECT,
        migrate: { project: PROJECT, legacyStore },
      });
      const filtered = steps.filter((s, i) => s !== "legacy-read" || steps[i - 1] !== "legacy-read");
      expect(filtered).toEqual(["host", "schema", "legacy-read", "migration", "recovery", "adapter", "commands"]);
    } finally {
      await db.close?.();
    }
  });

  test("setup recovers stale same-host effects after ensuring the schema", async () => {
    const { createLibSQLAdapter } = await import("swarm-mail");
    const { setupWorkUnitRuntime } = await import("../src/index");
    const { ensureWorkUnitSchema } = await import("../src/workunit/schema");
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      await ensureWorkUnitSchema(db);
      await db.query(
        `INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, claim_token, host_instance_id, claimed_hostname, claimed_by_pid, updated_at)
         VALUES ('e', 'u', 'backend_complete', 1, 1, 'in_flight', 'tok', 'h', 'box', 7, 0)`,
      );
      const workUnit = await setupWorkUnitRuntime(db, { host: { hostInstanceId: "h", hostname: "box", pid: 42 }, isProcessAlive: () => false });
      expect(workUnit.recovery.recovered).toBe(1);
    } finally {
      await db.close?.();
    }
  });

  test("setup: explicit runtime overrides (legacy or injected workUnit) skip default migration and write no tombstone", async () => {
    const { createLibSQLAdapter } = await import("swarm-mail");
    const { setupWorkUnitRuntime } = await import("../src/index");
    const db = await createLibSQLAdapter({ url: ":memory:" });
    try {
      const workUnit = await setupWorkUnitRuntime(db, { host: { hostInstanceId: "h", hostname: "box", pid: 42 }, isProcessAlive: () => true });
      for (const overrides of [{ runtime: { workUnit: undefined } }, { runtime: { workUnit } }]) {
        const ctx = createFakeContext({ projectId: PROJECT });
        const plugin = createSwarmxPlugin(overrides);
        await plugin.setup(ctx as unknown as Plugin.Context);
        expect(ctx.captures.toolTransforms).toHaveLength(1);
        const editor = ctx.createEditor();
        ctx.captures.toolTransforms[0]?.(editor);
        expect(editor.list().length).toBeGreaterThan(0);
        expect([...ctx.storage.map.keys()].filter((key) => key.startsWith("legacy-tombstone:"))).toEqual([]);
      }
      const missions = await db.query("SELECT COUNT(id) AS n FROM swarmx_missions");
      expect(Number((missions.rows[0] as { n: unknown }).n)).toBe(0);
    } finally {
      await db.close?.();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 13d2: native WorkUnit completion / review / cancel / finish routing.
// ---------------------------------------------------------------------------

interface NativeProject {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

/** Temp git repo with one code file and one doc file, both modified after the initial commit. */
async function createNativeProject(): Promise<NativeProject> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "swarmx-native-")));
  Bun.spawnSync(["mkdir", "-p", join(path, "src"), join(path, "docs")]);
  await writeFile(join(path, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(path, "docs/guide.md"), "# Guide\n");
  git(path, "init", "-q");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "init");
  await writeFile(join(path, "src/a.ts"), "export const a = 2;\n");
  await writeFile(join(path, "docs/guide.md"), "# Guide v2\n");
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

function fileDiff(file: string): string {
  return [`diff --git a/${file} b/${file}`, "@@ -1 +1 @@", "-old", "+new"].join("\n");
}

interface NativeRig {
  readonly rig: Rig;
  readonly native: { readonly runtime: WorkUnitRuntime; readonly missionPk: string };
  readonly project: NativeProject;
  readonly hive: Map<string, { status: string; completion_operation_id?: string }>;
  /** When set, swarm_review returns a different diff body (simulates drift after review). */
  drift: boolean;
}

async function createNativeRig(options: { readonly feedbackSucceeds?: boolean; readonly cleanupFails?: boolean } = {}): Promise<NativeRig> {
  const native = await createNativeMission();
  const project = await createNativeProject();
  const hive = new Map<string, { status: string; completion_operation_id?: string }>();
  const state = { drift: false };
  const rig = await createRig({
    agents: GATE_AGENTS,
    projectPath: project.path,
    workUnit: native.runtime,
    payloadFor: (name, args) => {
      if (name === "swarm_review") {
        const files = (args.files_touched as string[]) ?? [];
        return scopedReviewPayload(files, files.map((file) => (state.drift ? fileDiff(file).replace("+new", "+drifted") : fileDiff(file))).join("\n"));
      }
      if (name === "swarm_complete") {
        const cell = String(args.bead_id);
        hive.set(cell, { status: "closed", completion_operation_id: String(args.operation_id) });
        return { success: true };
      }
      if (name === "hive_cells") {
        const id = typeof args.id === "string" ? args.id : undefined;
        if (id !== undefined) return [{ id, ...(hive.get(id) ?? { status: "in_progress" }) }];
        return [...hive.entries()].map(([cellID, cell]) => ({ id: cellID, ...cell }));
      }
      if (name === "hive_create") return { id: "cell-consolidate" };
      if (name === "swarm_worktree_cleanup" && options.cleanupFails === true) {
        return { success: false, error: "cleanup backend exploded" };
      }
      if (name === "swarm_review_feedback") {
        return options.feedbackSucceeds === false ? { success: false, error: "rejected" } : { success: true };
      }
      return { ok: true };
    },
  });
  return {
    rig, native, project, hive,
    get drift() { return state.drift; },
    set drift(value: boolean) { state.drift = value; },
  };
}

async function nativeDispatch(n: NativeRig, cellID: string, callID: string, workerSessionID = "ses-worker"): Promise<void> {
  await n.native.runtime.commands.assignCell(nativeCoordinator, {
    missionPk: n.native.missionPk, cellId: cellID, agent: "swarm/swarm-worker",
  });
  const payload = workerDispatchPayload(cellID, callID);
  await n.rig.before(payload);
  const marker = extractCellMarker(payload.input);
  await n.rig.after({ ...payload, status: "completed", result: { sessionID: workerSessionID } });
  n.rig.bindWorkerSession(workerSessionID, marker, SESSION);
}

const WORKER_VERIFICATION = [{ name: "tests", command: "bun test", exit_code: 0, output: "ok" }];

async function nativeSubmit(
  n: NativeRig,
  cellID: string,
  files: readonly string[],
  extra: Record<string, unknown> = {},
  workerSessionID = "ses-worker",
): Promise<unknown> {
  const result = await n.rig.tools.get("swarm_complete")?.execute(
    {
      project_key: n.project.path, agent_name: "swarm-worker", bead_id: cellID,
      summary: `Completed ${cellID}.`, start_time: 1, files_touched: [...files], ...extra,
    },
    workerToolContext("swarm/swarm-worker", `call-complete-${cellID}`, workerSessionID),
  );
  return result?.output;
}

async function nativeReview(n: NativeRig, cellID: string, files: readonly string[]): Promise<void> {
  await n.rig.tools.get("swarm_review")?.execute(
    { project_key: n.project.path, epic_id: "epic-1", task_id: cellID, files_touched: [...files] },
    toolContext("swarm/swarm-coordinator", `call-review-${cellID}`),
  );
}

async function nativeFeedback(n: NativeRig, cellID: string, status: string, extra: Record<string, unknown> = {}) {
  return n.rig.tools.get("swarm_review_feedback")?.execute(
    { project_key: n.project.path, task_id: cellID, worker_id: "swarm/swarm-worker", status, summary: "reviewed", ...extra },
    toolContext("swarm/swarm-coordinator", `call-feedback-${cellID}-${status}`),
  );
}

async function nativeUnit(n: NativeRig, cellID: string) {
  const units = (await listUnits(n.native.runtime.db, n.native.missionPk)).filter((unit) => unit.cell_id === cellID);
  return units[units.length - 1]!;
}

async function nativeEffects(n: NativeRig, unitID: string): Promise<Record<string, unknown>[]> {
  return (await n.native.runtime.db.query("SELECT kind, state, operation_id, request_json FROM swarmx_effects WHERE unit_id = ? ORDER BY kind", [unitID]))
    .rows as Record<string, unknown>[];
}

describe("WorkUnit completion lifecycle", () => {
  const rigs: NativeRig[] = [];
  afterEach(async () => {
    for (const n of rigs.splice(0)) await n.project.cleanup();
  });
  async function nativeRig(options: { readonly feedbackSucceeds?: boolean; readonly cleanupFails?: boolean } = {}): Promise<NativeRig> {
    const n = await createNativeRig(options);
    rigs.push(n);
    return n;
  }

  test("WorkUnit dispatch→submit→amend→review→complete uses the amended files everywhere", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    expect(await nativeSubmit(n, "cell-a", ["src/a.ts", "docs/guide.md"])).toMatchObject({ status: "pending_review" });
    const submitted = await nativeUnit(n, "cell-a");
    expect(submitted.state).toBe("SUBMITTED");
    expect(await n.rig.ctx.storage.get(rawPendingCompletionKey(PROJECT, "cell-a"))).toBeUndefined();

    // Revert the code file so only the doc file still carries a diff.
    git(n.project.path, "checkout", "--", "src/a.ts");
    const amended = await n.rig.tools.get("swarm_amend_completion")?.execute(
      { bead_id: "cell-a", reason: "code change reverted", files_touched: ["src/a.ts", "docs/guide.md"] },
      workerToolContext("swarm/swarm-worker", "call-amend-a"),
    );
    expect(amended?.output).toMatchObject({ files_touched: ["docs/guide.md"], excluded: [{ file: "src/a.ts", reason: "no diff" }] });
    const afterAmend = await nativeUnit(n, "cell-a");
    expect(afterAmend).toMatchObject({
      state: "SUBMITTED",
      fence: submitted.fence + 1,
      evidence_json: submitted.evidence_json,
      evidence_hash: submitted.evidence_hash,
      diff_hash: submitted.diff_hash,
    });

    // The review must name the effective (amended) files, not the submitted ones.
    await expect(nativeReview(n, "cell-a", ["src/a.ts", "docs/guide.md"])).rejects.toThrow(/matching completion/);
    await nativeReview(n, "cell-a", ["docs/guide.md"]);
    expect((await nativeUnit(n, "cell-a")).state).toBe("IN_REVIEW");

    const feedback = await nativeFeedback(n, "cell-a", "approved");
    expect(feedback?.output).toMatchObject({ unit_state: "DONE", status: "unverifiable", approval_evidence: { status: "unverifiable" } });
    const done = await nativeUnit(n, "cell-a");
    expect(done).toMatchObject({ state: "DONE", review_verdict: "unverifiable", verification_receipt_json: null, evidence_json: submitted.evidence_json });
    const [effect] = await nativeEffects(n, done.id);
    expect(effect).toMatchObject({ kind: "backend_complete", state: "succeeded", operation_id: `op:${done.id}:backend_complete` });
    expect(JSON.parse(String(effect?.request_json))).toMatchObject({
      bead_id: "cell-a", agent_name: "swarm/swarm-worker", files_touched: ["docs/guide.md"], summary: "Completed cell-a.",
    });
    const reviewCalls = n.rig.runCalls.filter((call) => call.name === "swarm_review");
    expect(reviewCalls.at(-1)?.args.files_touched).toEqual(["docs/guide.md"]);
    expect(n.rig.runCalls.filter((call) => call.name === "swarm_complete").map((call) => call.args.files_touched))
      .toEqual([["docs/guide.md"]]);
  });

  test("WorkUnit ReceiptAndEffects: code approval needs a receipt and persists it before the effect", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"]);
    await nativeReview(n, "cell-a", ["src/a.ts"]);
    await expect(nativeFeedback(n, "cell-a", "approved")).rejects.toThrow(/verification receipt/);
    expect(await nativeEffects(n, (await nativeUnit(n, "cell-a")).id)).toEqual([]);

    await nativeDispatch(n, "cell-b", "call-b", "ses-worker-b");
    await nativeSubmit(n, "cell-b", ["src/a.ts"], { verification: WORKER_VERIFICATION }, "ses-worker-b");
    await nativeReview(n, "cell-b", ["src/a.ts"]);
    const feedback = await nativeFeedback(n, "cell-b", "approved");
    expect(feedback?.output).toMatchObject({ unit_state: "DONE", approval_evidence: { status: "approved" } });
    const done = await nativeUnit(n, "cell-b");
    const receipt = JSON.parse(String(done.verification_receipt_json));
    expect(receipt).toMatchObject({ files_touched: ["src/a.ts"], verification: { passed: true } });
    expect(receipt.diff_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await nativeEffects(n, done.id)).toMatchObject([
      { kind: "backend_complete", state: "succeeded", operation_id: `op:${done.id}:backend_complete` },
    ]);
  });

  test("WorkUnit needsChanges clears the worker, drains feedback and allows an explicit retry", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"]);
    await nativeReview(n, "cell-a", ["src/a.ts"]);
    const feedback = await nativeFeedback(n, "cell-a", "needs_changes", { issues: "fix it" });
    expect(feedback?.output).toMatchObject({ unit_state: "CHANGES_REQUESTED", effect: { kind: "backend_feedback", state: "succeeded" } });
    const returned = await nativeUnit(n, "cell-a");
    expect(returned).toMatchObject({ state: "CHANGES_REQUESTED", worker_session: null, review_verdict: "needs_changes" });
    const [effect] = await nativeEffects(n, returned.id);
    expect(JSON.parse(String(effect?.request_json))).toMatchObject({ task_id: "cell-a", status: "needs_changes", issues: "fix it" });

    const retry = await n.native.runtime.commands.retry(nativeCoordinator, {
      priorUnitId: returned.id, workerAgent: "swarm/swarm-worker", callId: "call-a-retry", dispatchToken: "tok-retry", budgetCharge: 1,
    });
    expect(retry).toMatchObject({ state: "RESERVED", attempt_no: 2, retry_of: returned.id, worker_agent: "swarm/swarm-worker" });
  });

  test("WorkUnit unit cancel goes SUBMITTED→CANCELLED through cancelCompletion", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"]);
    const unitID = (await nativeUnit(n, "cell-a")).id;
    await expect(n.native.runtime.commands.cancelCompletion({ kind: "worker", sessionId: "ses-worker" }, { unitId: unitID, reason: "x" }))
      .rejects.toThrow(/Coordinator command/);
    const result = await n.rig.tools.get("swarm_cancel_completion")?.execute(
      { bead_id: "cell-a", reason: "scope dropped" },
      toolContext("swarm/swarm-coordinator", "call-cancel-a"),
    );
    expect(result?.output).toEqual({ bead_id: "cell-a", canceled: true, reason: "scope dropped" });
    expect(await getWorkUnit(n.native.runtime.db, unitID)).toMatchObject({ state: "CANCELLED", reason: "scope dropped" });
    await expect(n.rig.tools.get("swarm_amend_completion")?.execute(
      { bead_id: "cell-a", reason: "late", files_touched: ["src/a.ts"] },
      workerToolContext("swarm/swarm-worker", "call-amend-late"),
    )).rejects.toThrow();
  });

  test("WorkUnit MissionBarrier: finish refuses pending reviews, then closes; abandon cascades", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["docs/guide.md"]);
    const finish = n.rig.tools.get("swarm_finish");
    await expect(finish?.execute({}, toolContext("swarm/swarm-coordinator", "call-finish-1"))).rejects.toThrow(/pending completion reviews/);
    expect((await getMission(n.native.runtime.db, PROJECT, SESSION))?.state).toBe("OPEN");
    await nativeReview(n, "cell-a", ["docs/guide.md"]);
    await nativeFeedback(n, "cell-a", "unverifiable");
    const finished = await finish?.execute({}, toolContext("swarm/swarm-coordinator", "call-finish-2"));
    expect(finished?.output).toMatchObject({ finished: true, active: false, state: "FINISHED" });

    const other = await nativeRig();
    await nativeDispatch(other, "cell-b", "call-b");
    await nativeSubmit(other, "cell-b", ["src/a.ts"]);
    const abandoned = await other.rig.tools.get("swarm_finish")?.execute(
      { abandon: true, reason: "stop" },
      toolContext("swarm/swarm-coordinator", "call-abandon"),
    );
    expect(abandoned?.output).toMatchObject({ state: "CANCELLED" });
    expect(await nativeUnit(other, "cell-b")).toMatchObject({ state: "CANCELLED", reason: "mission_cancel" });
  });

  test("WorkUnit Consolidation is prepared and completed through setConsolidation", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["docs/guide.md"]);
    await nativeReview(n, "cell-a", ["docs/guide.md"]);
    const feedback = await nativeFeedback(n, "cell-a", "approved");
    expect(feedback?.output).toMatchObject({ consolidation: { status: "ready", cell_id: "cell-consolidate" } });
    const mission = await getMission(n.native.runtime.db, PROJECT, SESSION);
    expect(JSON.parse(String(mission?.consolidation_json))).toMatchObject({ epicID: "epic-1", cellID: "cell-consolidate", status: "ready" });
    const assignment = await n.native.runtime.db.query(
      "SELECT agent, state FROM swarmx_legacy_assignments WHERE cell_id = 'cell-consolidate'",
    );
    expect(assignment.rows).toEqual([{ agent: "swarm/swarm-worker", state: "assigned" }]);

    await expect(n.native.runtime.commands.setConsolidation(
      { kind: "coordinator", sessionId: "ses-intruder" },
      { missionPk: n.native.missionPk, expectedFence: Number(mission?.fence), consolidation: null },
    )).rejects.toThrow(/does not own/);
    await expect(n.native.runtime.commands.setConsolidation(
      nativeCoordinator,
      { missionPk: n.native.missionPk, expectedFence: Number(mission?.fence) - 1, consolidation: null },
    )).rejects.toThrow(/fence/);

    await nativeDispatch(n, "cell-consolidate", "call-consolidate", "ses-worker-c");
    await nativeSubmit(n, "cell-consolidate", ["docs/guide.md"], {}, "ses-worker-c");
    await nativeReview(n, "cell-consolidate", ["docs/guide.md"]);
    await nativeFeedback(n, "cell-consolidate", "approved");
    const completed = await getMission(n.native.runtime.db, PROJECT, SESSION);
    expect(JSON.parse(String(completed?.consolidation_json))).toMatchObject({ status: "completed" });

    await n.rig.tools.get("swarm_finish")?.execute({}, toolContext("swarm/swarm-coordinator", "call-finish"));
    await expect(n.native.runtime.commands.setConsolidation(
      nativeCoordinator,
      { missionPk: n.native.missionPk, expectedFence: Number((await getMission(n.native.runtime.db, PROJECT, SESSION))?.fence ?? 0), consolidation: null },
    )).rejects.toThrow();
  });

  test("WorkUnit wrong-worker and non-owner negatives are refused", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts", "docs/guide.md"]);
    const unitID = (await nativeUnit(n, "cell-a")).id;
    await expect(n.native.runtime.commands.amendCompletion(
      { kind: "worker", sessionId: "ses-other" }, { unitId: unitID, filesTouched: ["docs/guide.md"], reason: "r" },
    )).rejects.toThrow(/not bound/);
    await expect(n.native.runtime.commands.amendCompletion(
      nativeCoordinator, { unitId: unitID, filesTouched: ["docs/guide.md"], reason: "r" },
    )).rejects.toThrow(/worker actor/);
    await expect(n.native.runtime.commands.beginReview({ kind: "coordinator", sessionId: "ses-intruder" }, { unitId: unitID }))
      .rejects.toThrow(/does not own/);
    await expect(nativeFeedback(n, "cell-a", "approved")).rejects.toThrow(/scoped review receipt/);
    expect((await nativeUnit(n, "cell-a")).state).toBe("SUBMITTED");
  });

  test("native dispatch preserves retry_of for a CHANGES_REQUESTED cell", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"]);
    await nativeReview(n, "cell-a", ["src/a.ts"]);
    await nativeFeedback(n, "cell-a", "needs_changes", { issues: "again" });
    const prior = await nativeUnit(n, "cell-a");
    expect(prior.state).toBe("CHANGES_REQUESTED");

    const payload = workerDispatchPayload("cell-a", "call-a-retry");
    await n.rig.before(payload);
    const token = extractCellMarker(payload.input).dispatchToken;
    await n.rig.before(payload); // replay with the attached token
    const units = (await listUnits(n.native.runtime.db, n.native.missionPk)).filter((unit) => unit.cell_id === "cell-a");
    expect(units).toHaveLength(2);
    expect(units[1]).toMatchObject({
      state: "RESERVED", call_id: "call-a-retry", dispatch_token: token, retry_of: prior.id,
      attempt_no: 2, worker_agent: "swarm/swarm-worker", budget_charge: 1,
    });
  });

  test("native review effects pass project path instead of project id", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["docs/guide.md"]);
    await nativeReview(n, "cell-a", ["docs/guide.md"]);
    await nativeFeedback(n, "cell-a", "approved");
    const [complete] = await nativeEffects(n, (await nativeUnit(n, "cell-a")).id);
    expect(JSON.parse(String(complete?.request_json)).project_key).toBe(n.project.path);
    expect(n.rig.runCalls.find((call) => call.name === "swarm_complete")?.args.project_key).toBe(n.project.path);

    await nativeDispatch(n, "cell-b", "call-b", "ses-worker-b");
    await nativeSubmit(n, "cell-b", ["src/a.ts"], {}, "ses-worker-b");
    await nativeReview(n, "cell-b", ["src/a.ts"]);
    await nativeFeedback(n, "cell-b", "needs_changes", { issues: "x" });
    const [feedback] = await nativeEffects(n, (await nativeUnit(n, "cell-b")).id);
    expect(JSON.parse(String(feedback?.request_json)).project_key).toBe(n.project.path);
  });

  test("native review persists the scoped review diff hash", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"], { verification: WORKER_VERIFICATION });
    await nativeReview(n, "cell-a", ["src/a.ts"]);
    const reviewed = await nativeUnit(n, "cell-a");
    expect(reviewed.state).toBe("IN_REVIEW");
    expect(reviewed.review_diff_hash).toMatch(/^[a-f0-9]{64}$/);
    await nativeFeedback(n, "cell-a", "approved");
    const done = await nativeUnit(n, "cell-a");
    expect(done.review_diff_hash).toBe(reviewed.review_diff_hash);
    expect(JSON.parse(String(done.verification_receipt_json)).diff_hash).toBe(reviewed.review_diff_hash);
  });

  test("native feedback rejects a diff changed after review", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"], { verification: WORKER_VERIFICATION });
    await nativeReview(n, "cell-a", ["src/a.ts"]);
    n.drift = true;
    await expect(nativeFeedback(n, "cell-a", "approved")).rejects.toThrow(/diff changed after review/);
    const unit = await nativeUnit(n, "cell-a");
    expect(unit).toMatchObject({ state: "IN_REVIEW", review_verdict: null });
    expect(await nativeEffects(n, unit.id)).toEqual([]);
  });

  async function nativeApprove(n: NativeRig, cellID: string, callID: string, workerSessionID: string): Promise<void> {
    await nativeDispatch(n, cellID, callID, workerSessionID);
    await nativeSubmit(n, cellID, ["docs/guide.md"], {}, workerSessionID);
    await nativeReview(n, cellID, ["docs/guide.md"]);
    await nativeFeedback(n, cellID, "approved");
    expect((await nativeUnit(n, cellID)).state).toBe("DONE");
  }

  function nativeFinish(n: NativeRig) {
    return n.rig.tools.get("swarm_finish")!.execute({}, toolContext("swarm/swarm-coordinator", "call-finish"));
  }

  test("WorkUnit MissionBarrier: finish requires consolidation when multiple work cells lack a completed consolidation", async () => {
    const n = await nativeRig();
    await nativeApprove(n, "cell-a", "call-a", "ses-worker");
    await nativeApprove(n, "cell-b", "call-b", "ses-worker-b");
    await expect(nativeFinish(n)).rejects.toThrow(/consolidation required/);
    const mission = await getMission(n.native.runtime.db, PROJECT, SESSION);
    expect(mission?.state).toBe("OPEN");
  });

  test("WorkUnit finish reports skipped worktree cleanup warning", async () => {
    const n = await nativeRig();
    await nativeApprove(n, "cell-a", "call-a", "ses-worker");
    // Without a resolvable canonical project root, cleanup is skipped, not failed.
    await n.project.cleanup();
    const result = await nativeFinish(n);
    expect((result.output as { warnings?: unknown }).warnings).toEqual([
      expect.objectContaining({ type: "warning", code: "worktree_cleanup_skipped", taskID: "cell-a" }),
    ]);
    expect(n.rig.runCalls.some((call) => call.name === "swarm_worktree_cleanup")).toBe(false);
  });

  test("WorkUnit finish reports failed worktree cleanup warning", async () => {
    const n = await nativeRig({ cleanupFails: true });
    await nativeApprove(n, "cell-a", "call-a", "ses-worker");
    const result = await nativeFinish(n);
    expect((result.output as { finished?: boolean }).finished).toBe(true);
    expect((result.output as { warnings?: unknown }).warnings).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "worktree_cleanup_failed",
        taskID: "cell-a",
        message: "cleanup backend exploded",
      }),
    ]);
  });

  test("WorkUnit review rejects files outside the reviewed project scope", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    await nativeSubmit(n, "cell-a", ["src/a.ts"]);
    await expect(nativeReview(n, "cell-a", ["../outside.ts"])).rejects.toThrow(/invalid_input.*portable repo-relative/);
    await expect(nativeReview(n, "cell-a", ["/etc/passwd"])).rejects.toThrow(/swarm_review failed .invalid_input./);
    expect(n.rig.runCalls.some((call) => call.name === "swarm_review")).toBe(false);
    expect((await nativeUnit(n, "cell-a")).state).toBe("SUBMITTED");
  });

  test("WorkUnit completion records missing_start_time violation and uses fallback", async () => {
    const n = await nativeRig();
    const previous = process.env.SWARM_SESSIONS_DIR;
    const sessionsDir = join(n.project.path, ".sessions");
    process.env.SWARM_SESSIONS_DIR = sessionsDir;
    try {
      await nativeDispatch(n, "cell-a", "call-a");
      const output = await nativeSubmit(n, "cell-a", ["src/a.ts"], { start_time: undefined });
      expect(output).toMatchObject({ status: "pending_review" });
      expect((await nativeUnit(n, "cell-a")).state).toBe("SUBMITTED");
      const events = readdirSync(sessionsDir)
        .flatMap((file) => readFileSync(join(sessionsDir, file), "utf-8").split("\n"))
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.event_type === "VIOLATION");
      expect(events).toEqual([
        expect.objectContaining({
          violation_type: "missing_start_time",
          payload: expect.objectContaining({ tool: "swarm_complete", bead_id: "cell-a" }),
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.SWARM_SESSIONS_DIR;
      else process.env.SWARM_SESSIONS_DIR = previous;
    }
  });

  test("native pending completion is denied without a legacy store", async () => {
    const n = await nativeRig();
    await nativeDispatch(n, "cell-a", "call-a");
    const edit = () => n.rig.ctx.permission.assert({
      sessionID: "ses-worker",
      agent: "swarm/swarm-worker",
      source: { type: "tool", messageID: "msg-pending", id: `call-edit-${Math.random()}` },
      action: "edit",
      resources: ["src/a.ts"],
    });
    await expect(edit()).resolves.toBeUndefined();
    await nativeSubmit(n, "cell-a", ["src/a.ts"]);
    // The native path never writes the legacy pending-completion key.
    expect(await n.rig.ctx.storage.get(rawPendingCompletionKey(PROJECT, "cell-a"))).toBeUndefined();
    await expect(edit()).rejects.toThrow(/pending_completion/);
    await nativeReview(n, "cell-a", ["src/a.ts"]);
    await expect(edit()).rejects.toThrow(/pending_completion/);
  });

});

describe("Task 13d3d1: remaining mission tools route through WorkUnits", () => {
  async function bareNative(): Promise<WorkUnitRuntime> {
    const db = await createLibSQLAdapter({ url: ":memory:" });
    openedWorkUnitDatabases.push(db);
    return setupWorkUnitRuntime(db, {
      projectID: PROJECT,
      host: { hostInstanceId: "runtime-smoke", hostname: "test-host", pid: 1 },
    });
  }

  async function reserveUnit(runtime: WorkUnitRuntime, cellId: string, callId: string, sessionID = SESSION) {
    return runtime.commands.reserve({ kind: "coordinator", sessionId: sessionID }, {
      project: PROJECT, missionId: `work-${sessionID}`, workerAgent: "swarm/swarm-worker",
      callId, dispatchToken: `token-${callId}`, cellId, budgetCharge: 1, idemKey: callId, attemptNo: 1,
    });
  }

  test("native set_budget applies defaults, conflicts while active, and recreates after reset", async () => {
    const native = await bareNative();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native });
    const dev = await rig.tools.get("swarm_set_budget")?.execute({}, toolContext());
    expect(dev?.output).toEqual({ sessionID: SESSION, mode: "dev", active: true, budget: { maxSpawns: 20, maxIterations: 3, workerShare: expect.any(Number) } });
    expect(dev?.content).toBe("Budget fixed: mode=dev max_spawns=20 max_iterations=3");
    const first = await getMission(native.db, PROJECT, SESSION);
    await expect(rig.tools.get("swarm_set_budget")?.execute({ mode: "audit" }, toolContext()))
      .rejects.toThrow(/conflict/);
    await rig.tools.get("swarm_reset")?.execute({}, toolContext());
    const audit = await rig.tools.get("swarm_set_budget")?.execute({ mode: "audit" }, toolContext());
    expect(audit?.output).toMatchObject({ sessionID: SESSION, mode: "audit", active: true, budget: { maxSpawns: 10, maxIterations: 3 } });
    const second = await getMission(native.db, PROJECT, SESSION);
    expect(second?.state).toBe("OPEN");
    expect(second?.mission_id).not.toBe(first?.mission_id);
    expect(await rig.ctx.storage.get(`mission:${PROJECT}:${SESSION}`)).toBeUndefined();
  });

  test("setBudget/recordRetryCause commands are actor-checked", async () => {
    const native = await bareNative();
    const policy = { total: 5, perCellIterations: 2, workerShare: null, version: 1 as const };
    await expect(native.commands.setBudget({ kind: "worker", sessionId: SESSION }, { project: PROJECT, sessionId: SESSION, mode: "dev", budgetPolicy: policy }))
      .rejects.toThrow(/worker actor/);
    await expect(native.commands.setBudget({ kind: "coordinator", sessionId: "other" }, { project: PROJECT, sessionId: SESSION, mode: "dev", budgetPolicy: policy }))
      .rejects.toThrow(/cannot budget/);
    const mission = await native.commands.setBudget(nativeCoordinator, { project: PROJECT, sessionId: SESSION, mode: "dev", budgetPolicy: policy });
    const cause = { cellID: "c", epicID: "e", attempt: 1, ts: "2026-01-01T00:00:00.000Z", failureReason: "boom" };
    await expect(native.commands.recordRetryCause({ kind: "coordinator", sessionId: "other" }, { missionPk: mission.id, cause }))
      .rejects.toThrow(/does not own/);
    const updated = await native.commands.recordRetryCause(nativeCoordinator, { missionPk: mission.id, cause });
    expect(JSON.parse(updated.retry_causes_json ?? "[]")).toEqual([cause]);
  });

  test("native mission_status projects unit counts, pending completions and orphan candidates", async () => {
    const native = await createNativeMission({ total: 10 });
    await reserveUnit(native.runtime, "cell-a", "call-a");
    await reserveUnit(native.runtime, "cell-b", "call-b");
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const result = await rig.tools.get("swarm_mission_status")?.execute({}, toolContext());
    expect(result?.output).toMatchObject({
      projectID: PROJECT,
      missions: [{ sessionID: SESSION, active: true, mode: "dev", attempts: 2, unrevokedAttempts: 2, pendingCompletions: [] }],
      orphanAttempts: 2,
    });
    expect(String(result?.content)).toContain("orphan attempts: 2");
  });

  test("native agent_audit derives attempts from units and reports orphan candidates without repair", async () => {
    const native = await createNativeMission({ total: 10 });
    await reserveUnit(native.runtime, "cell-a", "call-a");
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const result = await rig.tools.get("swarm_agent_audit")?.execute({}, toolContext());
    const output = result?.output as Record<string, unknown>;
    expect(output).toMatchObject({ active: true, mode: "dev", sessionID: SESSION, pendingOrphans: 1, workerSpawns: 1, workerShare: 1, consolidation: null });
    expect(output.attempts).toMatchObject([{ callID: "call-a", cellID: "cell-a", sessionID: SESSION, status: "pending" }]);
    expect(Array.isArray(output.cells)).toBe(true);
    expect(String(result?.content)).toContain("attempts: 1, pending orphan candidates: 1");
    expect(String(result?.content)).not.toContain("repaired");
    expect((await listUnits(native.runtime.db, native.missionPk))[0]?.state).toBe("RESERVED");
  });

  test("native spawn_retry persists the root cause through recordRetryCause", async () => {
    const native = await createNativeMission();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime, payload: { prompt: "retry" } });
    await rig.tools.get("swarm_spawn_retry")?.execute(
      { bead_id: "cell-a", epic_id: "epic-1", attempt: 2, original_prompt: "p", failure_reason: "tests failed", failed_command: "bun test", error_excerpt: "boom" },
      toolContext(),
    );
    const mission = await getMission(native.runtime.db, PROJECT, SESSION);
    expect(JSON.parse(mission?.retry_causes_json ?? "[]")).toMatchObject([{ cellID: "cell-a", epicID: "epic-1", attempt: 2, failureReason: "tests failed" }]);
  });

  test("native guards: hive_close and hive_update closed block on an active native mission", async () => {
    const native = await createNativeMission();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    await expect(rig.tools.get("hive_close")?.execute({ id: "cell-a", reason: "x" }, toolContext()))
      .rejects.toThrow(/active swarmx cells close only through an approved swarm_complete call/);
    await expect(rig.tools.get("hive_update")?.execute({ id: "cell-a", status: "closed" }, toolContext()))
      .rejects.toThrow(/active swarmx cells close only through an approved swarm_complete call/);
    expect(rig.runCalls.filter((call) => call.name === "hive_close" || call.name === "hive_update")).toHaveLength(0);
  });

  test("native guards: hive_close allowed with no live mission/unit; mission owner passes coordinator check", async () => {
    const native = await bareNative();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native });
    await rig.tools.get("hive_close")?.execute({ id: "cell-z", reason: "done" }, toolContext());
    expect(rig.runCalls.some((call) => call.name === "hive_close")).toBe(true);
  });

  test("native cleanup discovers missions from projection and refuses a live task unit", async () => {
    const native = await createNativeMission();
    await reserveUnit(native.runtime, "cell-a", "call-a");
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime, projectPath: process.cwd() });
    await expect(rig.tools.get("swarm_worktree_cleanup")?.execute({ task_id: "cell-a", project_path: process.cwd() }, toolContext()))
      .rejects.toThrow(/task cell-a has an unrevoked worker attempt/);
    await expect(rig.tools.get("swarm_worktree_cleanup")?.execute({ cleanup_all: true, project_path: process.cwd() }, toolContext()))
      .rejects.toThrow(/active swarmx cells close only through an approved swarm_complete call/);
    expect(rig.runCalls.some((call) => call.name === "swarm_worktree_cleanup")).toBe(false);
  });

  async function forceState(runtime: WorkUnitRuntime, unitId: string, state: string, updatedAt: number) {
    // Test-only fixture: place a unit directly in a target lifecycle state.
    await runtime.db.query("UPDATE swarmx_work_units SET state = ?, updated_at = ?, created_at = ? WHERE id = ?", [state, updatedAt, updatedAt, unitId]);
  }

  for (const [state, allowed] of [["APPROVED", true], ["PUBLISHING", true], ["DONE", true], ["SUBMITTED", false]] as const) {
    test(`native hive_close with latest unit ${state} ${allowed ? "allows" : "blocks"} close`, async () => {
      const native = await createNativeMission({ total: 10 });
      const unit = await reserveUnit(native.runtime, "cell-a", `call-${state}`);
      await forceState(native.runtime, unit.id, state, 1_000);
      const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
      const close = rig.tools.get("hive_close")?.execute({ id: "cell-a", reason: "x" }, toolContext());
      if (allowed) {
        await close;
        expect(rig.runCalls.some((call) => call.name === "hive_close")).toBe(true);
      } else {
        await expect(close).rejects.toThrow(/approved swarm_complete call or an approved review receipt/);
      }
    });
  }

  test("native hive_close blocks newer submitted unit despite older done unit", async () => {
    const native = await createNativeMission({ total: 10 });
    const older = await reserveUnit(native.runtime, "cell-a", "call-old");
    await forceState(native.runtime, older.id, "DONE", 1_000);
    const newer = await reserveUnit(native.runtime, "cell-a", "call-new");
    await forceState(native.runtime, newer.id, "SUBMITTED", 2_000);
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    await expect(rig.tools.get("hive_close")?.execute({ id: "cell-a", reason: "x" }, toolContext()))
      .rejects.toThrow(/approved swarm_complete call or an approved review receipt/);
    expect(rig.runCalls.some((call) => call.name === "hive_close")).toBe(false);
  });

  test("characterization: recordRetryCause retries after a mission fence conflict", async () => {
    const native = await bareNative();
    const policy = { total: 5, perCellIterations: 2, workerShare: null, version: 1 as const };
    const mission = await native.commands.setBudget(nativeCoordinator, { project: PROJECT, sessionId: SESSION, mode: "dev", budgetPolicy: policy });
    const realQuery = native.db.query.bind(native.db);
    let bumped = false;
    (native.db as { query: typeof realQuery }).query = (async (sql: string, params?: unknown[]) => {
      if (!bumped && sql.startsWith("UPDATE swarmx_missions SET retry_causes_json")) {
        bumped = true;
        await realQuery("UPDATE swarmx_missions SET fence = fence + 1 WHERE id = ?", [mission.id]);
      }
      return realQuery(sql, params);
    }) as typeof realQuery;
    const cause = { cellID: "c", epicID: "e", attempt: 1, ts: "2026-01-01T00:00:00.000Z" };
    const updated = await native.commands.recordRetryCause(nativeCoordinator, { missionPk: mission.id, cause });
    expect(bumped).toBe(true);
    expect(JSON.parse(updated.retry_causes_json ?? "[]")).toEqual([cause]);
  });

  test("characterization: native mission_status emits one row per session across generations", async () => {
    const native = await bareNative();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native });
    await rig.tools.get("swarm_set_budget")?.execute({}, toolContext());
    await rig.tools.get("swarm_reset")?.execute({}, toolContext());
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "audit" }, toolContext());
    const result = await rig.tools.get("swarm_mission_status")?.execute({}, toolContext());
    const rows = (result?.output as { missions: { sessionID: string; active: boolean; mode: string }[] }).missions;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionID: SESSION, active: true, mode: "audit" });
  });

  test("characterization: native set_budget maps policy validation to invalid_input and honours explicit limits", async () => {
    const native = await bareNative();
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native });
    await expect(rig.tools.get("swarm_set_budget")?.execute({ max_spawns: -1 }, toolContext()))
      .rejects.toThrow(/invalid_input/);
    const result = await rig.tools.get("swarm_set_budget")?.execute({ mode: "audit", max_spawns: 7, max_iterations: 5 }, toolContext());
    expect(result?.output).toMatchObject({ mode: "audit", budget: { maxSpawns: 7, maxIterations: 5 } });
    expect(result?.content).toBe("Budget fixed: mode=audit max_spawns=7 max_iterations=5");
  });

  test("compaction projects native MissionState with display-only orphan count", async () => {
    const native = await createNativeMission({ total: 10 });
    await reserveUnit(native.runtime, "cell-a", "call-a");
    const rig = await createRig({ agents: GATE_AGENTS, workUnit: native.runtime });
    const [hook] = rig.ctx.captures.sessionHooks.get("compaction") ?? [];
    const event = rig.ctx.createCompactionEvent({ sessionID: SESSION });
    await hook!(event);
    const text = event.system.at(-1)?.text ?? "";
    expect(text).toContain("<swarmx_facts>");
    expect(text).toContain("counts spawns=1");
    expect(text).toContain("pendingOrphans=1");
    expect((await listUnits(native.runtime.db, native.missionPk))[0]?.state).toBe("RESERVED");
  });
});
