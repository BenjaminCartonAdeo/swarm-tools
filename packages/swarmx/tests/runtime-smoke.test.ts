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
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";

import swarmx, { createSwarmxPlugin } from "../src/index";
import { findToolSpec, listToolNames, pendingCompletionKey } from "../src/catalog";
import { extractCellMarker } from "../src/dispatch";
import {
  createMissionStateStore,
  getAttempt,
  readMission,
  resolveAssignment,
  setAssignment,
  setBudget,
  type MissionStorageLike,
} from "../src/state";
import { UnsupportedToolError, type CellMarker } from "../src/types";
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

  test("worker permissions block every denied local mission mutation", async () => {
    const cases = [
      { tool: "swarm_set_budget", input: { mode: "audit" } },
      {
        tool: "swarm_set_agent",
        input: { bead_id: "cell-a", agent: "development/typescript-pro" },
      },
      {
        tool: "swarm_resolve_agent",
        input: {
          apply: true,
          cells: [{ bead_id: "cell-a", title: "Implement endpoint", files: ["src/handler.ts"] }],
        },
      },
      { tool: "swarm_finish", input: { reason: "done" } },
    ] as const;

    for (const [index, entry] of cases.entries()) {
      const rig = await createRig({ agents: GATE_AGENTS });
      const tool = rig.tools.get(entry.tool);
      expect(tool).toBeDefined();

      await expect(tool?.execute(entry.input, workerToolContext("swarm/swarm-worker", `call-denied-${index}`)))
        .rejects.toThrow(`permission denied: ${entry.tool}`);

      expect(rig.ctx.captures.permissionAssertions).toEqual([
        {
          sessionID: "ses-worker",
          agent: "swarm/swarm-worker",
          source: { type: "tool", messageID: "msg-local-tool", id: `call-denied-${index}` },
          action: entry.tool,
          resources: [entry.tool],
          save: [entry.tool],
        },
      ]);
      expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toBeUndefined();
      expect(await resolveAssignment(missionStore(rig.ctx), PROJECT, "cell-a")).toBeUndefined();
    }

    const allowedRig = await createRig({ agents: GATE_AGENTS });
    const auditTool = allowedRig.tools.get("swarm_agent_audit");
    expect(auditTool).toBeDefined();
    const auditResult = await auditTool?.execute(
      {},
      workerToolContext("swarm/swarm-worker", "call-allowed-audit"),
    );
    expect(auditResult?.output).toMatchObject({ active: false, sessionID: "ses-worker" });
    expect(allowedRig.ctx.captures.permissionAssertions).toEqual([
      {
        sessionID: "ses-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-local-tool", id: "call-allowed-audit" },
        action: "swarm_agent_audit",
        resources: ["swarm_agent_audit"],
        save: ["swarm_agent_audit"],
      },
    ]);
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

  test("workers can release their paths but cannot release foreign reservation IDs", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-release-paths");
    const release = rig.tools.get("swarmmail_release");
    expect(release).toBeDefined();

    await expect(
      release?.execute(
        { reservation_ids: [42] },
        workerToolContext("swarm/swarm-worker", "call-release-foreign-id"),
      ),
    ).rejects.toThrow(/subagents may release reservation paths, not reservation IDs/);
    expect(rig.runCalls).toHaveLength(0);

    await release?.execute(
      { paths: [SWARMX_FILE] },
      workerToolContext("swarm/swarm-worker", "call-release-own-path"),
    );
    expect(rig.runCalls).toEqual([
      { name: "swarmmail_release", args: { paths: [SWARMX_FILE] } },
    ]);
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

  test("swarmmail_init binds identity, project, and CLI session to the V2 caller", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-swarmmail-init");
    const init = rig.tools.get("swarmmail_init");
    expect(init).toBeDefined();

    await expect(
      init?.execute(
        { project_path: projectPath, agent_name: "build", task_description: "spoof" },
        workerToolContext("swarm/swarm-worker", "call-spoof-swarmmail"),
      ),
    ).rejects.toThrow(/agent_name must match the V2 caller/);
    expect(rig.runCalls).toHaveLength(0);

    await init?.execute(
      { project_path: projectPath, task_description: "assigned cell" },
      workerToolContext("swarm/swarm-worker", "call-init-swarmmail"),
    );
    expect(rig.runCalls).toEqual([
      {
        name: "swarmmail_init",
        args: {
          project_path: projectPath,
          agent_name: "swarm-worker",
          task_description: "assigned cell",
        },
      },
    ]);
    expect(rig.runEnvironments).toEqual([
      { name: "swarmmail_init", env: { OPENCODE_SESSION_ID: "ses-worker" } },
    ]);
  });

  test("subagents can report completion without bypassing review or verification", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath: process.cwd(),
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-complete");
    const tool = rig.tools.get("swarm_complete");
    expect(tool).toBeDefined();
    const input = {
      project_key: process.cwd(),
      agent_name: "swarm-worker",
      bead_id: "cell-a",
      summary: "Completed the assigned work.",
      start_time: 1,
      files_touched: [SWARMX_FILE],
    };

    const completion = await tool?.execute(input, workerToolContext("swarm/swarm-worker", "call-complete"));

    expect((completion?.output as { status: string }).status).toBe("pending_review");
    expect(rig.runCalls).toEqual([]);
    expect(rig.ctx.captures.permissionAssertions.at(-1)?.action).toBe("swarm_complete");
    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-submitted-worker", id: "call-edit-after-submit" },
        action: "edit",
        resources: [SWARMX_FILE],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked/);
  });

  test("swarm_complete defaults an omitted start_time to the submission time", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath: process.cwd(),
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-default-start");
    const tool = rig.tools.get("swarm_complete");
    expect(tool).toBeDefined();
    const input = {
      project_key: process.cwd(),
      agent_name: "swarm-worker",
      bead_id: "cell-a",
      summary: "Completed without a start_time.",
      files_touched: [SWARMX_FILE],
    };

    await expect(
      tool?.execute(
        { ...input, start_time: -1 },
        workerToolContext("swarm/swarm-worker", "call-complete-bad-start"),
      ),
    ).rejects.toThrow(/start_time must be a non-negative/);

    const before = Date.now();
    const completion = await tool?.execute(
      input,
      workerToolContext("swarm/swarm-worker", "call-complete-default-start"),
    );
    const after = Date.now();

    expect((completion?.output as { status: string }).status).toBe("pending_review");
    const pending = (await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-a"))) as
      | { startTime?: number }
      | undefined;
    expect(typeof pending?.startTime).toBe("number");
    expect(Number.isSafeInteger(pending?.startTime)).toBe(true);
    expect(pending?.startTime).toBeGreaterThanOrEqual(before);
    expect(pending?.startTime).toBeLessThanOrEqual(after);
    expect(rig.runCalls).toEqual([]);
  });

  test("completion submissions stay bound to the dispatched cell and caller", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath: process.cwd(),
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-completion-scope");
    const tool = rig.tools.get("swarm_complete");
    const input = {
      project_key: process.cwd(),
      agent_name: "swarm-worker",
      bead_id: "cell-a",
      summary: "Completed the assigned work.",
      start_time: 1,
      files_touched: [SWARMX_FILE],
    };

    await expect(
      tool?.execute({ ...input, bead_id: "cell-other" }, workerToolContext("swarm/swarm-worker", "call-wrong-cell")),
    ).rejects.toThrow(/does not match the caller's assigned cell/);
    await expect(
      tool?.execute(input, workerToolContext("development/typescript-pro", "call-wrong-caller")),
    ).rejects.toThrow(/caller is not the agent assigned to this cell/);
  });

  test("needs_changes revokes the old worker capability before a retry dispatch", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const diffPayload = {
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
    };
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) => (name === "swarm_review" ? diffPayload : { success: true }),
    });
    const oldMarker = await dispatchWorker(rig, "cell-a", "call-dispatch-old-worker", "ses-worker-old");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "First attempt.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-old-worker", "ses-worker-old"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext(),
    );
    await rig.tools.get("swarm_review_feedback")?.execute(
      {
        project_key: projectPath,
        task_id: "cell-a",
        worker_id: "swarm/swarm-worker",
        status: "needs_changes",
        summary: "Fix the reviewed issue.",
        issues: "[]",
      },
      toolContext("swarm/swarm-coordinator", "call-feedback-old-worker"),
    );

    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-worker-old",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-retired-worker", id: "call-retired-edit" },
        action: "edit",
        resources: [SWARMX_FILE],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked/);
    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-worker-old",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-retired-worker", id: "call-retired-shell" },
        action: "shell",
        resources: ["git status --short"],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked/);

    const newMarker = await dispatchWorker(rig, "cell-a", "call-dispatch-new-worker", "ses-worker-new");
    expect(newMarker.dispatchToken).not.toBe(oldMarker.dispatchToken);
    await expect(
      rig.tools.get("swarm_complete")?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          summary: "Stale first attempt.",
          start_time: 1,
          files_touched: [file],
        },
        workerToolContext("swarm/swarm-worker", "call-stale-completion", "ses-worker-old"),
      ),
    ).rejects.toThrow(/dispatch capability is no longer active/);
    const retry = await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Retry attempt.",
        start_time: 2,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-new-worker", "ses-worker-new"),
    );
    expect((retry?.output as { status: string }).status).toBe("pending_review");
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

  test("a sibling session cannot reuse the same cell's dispatch capability", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    const marker = await dispatchWorker(rig, "cell-a", "call-dispatch-session-capability");
    const update = rig.tools.get("hive_update");
    expect(update).toBeDefined();

    await update?.execute(
      { id: "cell-a", status: "in_progress" },
      workerToolContext("swarm/swarm-worker", "call-bind-worker-session"),
    );
    rig.bindWorkerSession("ses-sibling", marker, SESSION);

    await expect(
      update?.execute(
        { id: "cell-a", status: "blocked" },
        toolContext("swarm/swarm-worker", "call-sibling-reuse", "ses-sibling"),
      ),
    ).rejects.toThrow(/dispatch capability is already bound to another worker session/);
    expect(rig.runCalls).toHaveLength(1);
  });

  test("coordinator cannot use hive_close to bypass worker completion in an active mission", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("hive_close")?.execute(
        { id: "cell-a", reason: "bypass" },
        toolContext("swarm/swarm-coordinator", "call-direct-close"),
      ),
    ).rejects.toThrow(/active swarmx cells close only through an approved swarm_complete/);
    expect(rig.runCalls).toHaveLength(0);
  });

  test("coordinator cannot close a cell from another session while a project mission is active", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("hive_close")?.execute(
        { id: "cell-a", reason: "cross-session bypass" },
        { sessionID: "ses-other", agent: "swarm/swarm-coordinator", messageID: "msg-other", id: "call-cross-session-close" },
      ),
    ).rejects.toThrow(/active swarmx cells close only through an approved swarm_complete/);
    expect(rig.runCalls).toHaveLength(0);
  });

  test("coordinator cannot mark a cell closed with hive_update during an active mission", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("hive_update")?.execute(
        { id: "cell-a", status: "closed" },
        toolContext("swarm/swarm-coordinator", "call-close-with-update"),
      ),
    ).rejects.toThrow(/close only through an approved swarm_complete/);
    expect(rig.runCalls).toHaveLength(0);
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

  test("coordinator cannot finish a mission with unrevoked worker attempts", async () => {
    const rig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-finish-blocked");

    await expect(
      rig.tools.get("swarm_finish")?.execute({ reason: "premature" }, toolContext()),
    ).rejects.toThrow(/unrevoked worker attempts/);
    expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toMatchObject({ active: true });
  });

  test("a primary session owning the mission may finish it without being the coordinator", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "audit", max_spawns: 5 }, toolContext());
    expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toMatchObject({ active: true });

    const result = await rig.tools
      .get("swarm_finish")
      ?.execute({ reason: "owner release" }, toolContext("build", "call-owner-finish"));

    expect((result?.output as { finished?: boolean }).finished).toBe(true);
    expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toMatchObject({ active: false });
  });

  test("a primary session without an owned mission still cannot finish", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await expect(
      rig.tools
        .get("swarm_finish")
        ?.execute({ reason: "no mission" }, toolContext("build", "call-stranger-finish")),
    ).rejects.toThrow("no mission for session");
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

  test("workers may mark their cell blocked but cannot close or reconfigure it", async () => {
    const allowedRig = await createRig({
      agents: GATE_AGENTS,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(allowedRig, "cell-a", "call-dispatch-blocked");
    const updateTool = allowedRig.tools.get("hive_update");
    expect(updateTool).toBeDefined();
    await updateTool?.execute(
      { id: "cell-a", status: "blocked" },
      workerToolContext("swarm/swarm-worker", "call-block-cell"),
    );
    expect(allowedRig.runCalls).toEqual([
      { name: "hive_update", args: { id: "cell-a", status: "blocked" } },
    ]);

    for (const [index, input] of [
      { id: "cell-a", status: "closed" },
      { id: "cell-a", description: "Changed scope" },
    ].entries()) {
      const rig = await createRig({
        agents: GATE_AGENTS,
        workerCell: { cellID: "cell-a", epicID: "epic-1" },
      });
      await dispatchWorker(rig, "cell-a", `call-dispatch-forbidden-${index}`);
      const tool = rig.tools.get("hive_update");
      await expect(
        tool?.execute(input, workerToolContext("swarm/swarm-worker", `call-forbidden-update-${index}`)),
      ).rejects.toThrow(/subagents may only set their assigned cell|a subagent may update only its assigned cell/);
      expect(rig.runCalls).toHaveLength(0);
    }
  });

  test("swarm_progress changes only the assigned cell and only to a non-terminal status", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-progress");
    const progress = rig.tools.get("swarm_progress");
    expect(progress).toBeDefined();

    await expect(
      progress?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm-worker",
          bead_id: "cell-b",
          status: "blocked",
        },
        workerToolContext("swarm/swarm-worker", "call-progress-wrong-cell"),
      ),
    ).rejects.toThrow(/only the assigned cell/);
    await expect(
      progress?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          status: "completed",
        },
        workerToolContext("swarm/swarm-worker", "call-progress-terminal"),
      ),
    ).rejects.toThrow(/terminal progress status/);
    expect(rig.runCalls).toHaveLength(0);

    await progress?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        status: "blocked",
      },
      workerToolContext("swarm/swarm-worker", "call-progress-valid"),
    );
    expect(rig.runCalls).toEqual([
      {
        name: "swarm_progress",
        args: {
          project_key: projectPath,
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          status: "blocked",
        },
      },
    ]);
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

  test("swarm_complete refuses files_touched outside the active project", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-completion-scope");
    const complete = rig.tools.get("swarm_complete");
    expect(complete).toBeDefined();

    const invalidFiles = [["../AGENTS.md"], ["/etc/passwd"], ["opencode/../AGENTS.md"]];
    for (const [index, filesTouched] of invalidFiles.entries()) {
      await expect(
        complete?.execute(
          {
            project_key: projectPath,
            agent_name: "swarm-worker",
            bead_id: "cell-a",
            summary: "Out-of-scope completion.",
            files_touched: filesTouched,
          },
          workerToolContext("swarm/swarm-worker", `call-completion-scope-${index}`),
        ),
      ).rejects.toThrow(/files_touched/);
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

  test("swarm_review accepts a relative project key and normalizes relative files", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
        review_prompt: [
          "## Files Modified",
          `- \`${file}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${file} b/${file}`,
          "@@ -1 +1 @@",
          "-old",
          "+relative",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
        context: { files_touched: [file] },
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-relative");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed with relative paths.",
        start_time: 1,
        files_touched: [`./${file}`],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-relative"),
    );
    await rig.tools.get("swarm_review")?.execute(
      {
        project_key: ".",
        epic_id: "epic-1",
        task_id: "cell-a",
        files_touched: [`./${file}`],
      },
      toolContext("swarm/swarm-coordinator", "call-review-relative"),
    );

    expect(rig.runCalls).toEqual([
      {
        name: "swarm_review",
        args: {
          project_key: projectPath,
          epic_id: "epic-1",
          task_id: "cell-a",
          files_touched: [file],
        },
      },
    ]);
  });

  test("swarm_review rejects a dangling symlink that targets outside the project", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "swarmx-review-symlink-"));
    const missingOutsideTarget = `${projectPath}-outside-missing`;
    await symlink(missingOutsideTarget, join(projectPath, "dangling-link"));
    try {
      const rig = await createRig({ agents: GATE_AGENTS, projectPath });
      await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

      await expect(
        rig.tools.get("swarm_review")?.execute(
          {
            project_key: projectPath,
            epic_id: "epic-1",
            task_id: "cell-dangling-link",
            files_touched: ["dangling-link"],
          },
          toolContext("swarm/swarm-coordinator", "call-review-dangling"),
        ),
      ).rejects.toThrow(/files_touched/);
      expect(rig.runCalls).toHaveLength(0);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
      await rm(missingOutsideTarget, { force: true });
    }
  });

  test("swarm_review forwards only normalized files inside the active project", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
        review_prompt: [
          "## Files Modified",
          `- \`${file}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${file} b/${file}`,
          "@@ -1 +1 @@",
          "-old",
          "+change",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
        context: { files_touched: [file] },
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-review-normalized");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed the assigned work.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-review-normalized"),
    );
    const tool = rig.tools.get("swarm_review");
    expect(tool).toBeDefined();

    await tool?.execute(
      {
        project_key: projectPath,
        epic_id: "epic-1",
        task_id: "cell-a",
        files_touched: [`./${file}`],
      },
      toolContext(),
    );

    expect(rig.runCalls).toEqual([
      {
        name: "swarm_review",
        args: {
          project_key: projectPath,
          epic_id: "epic-1",
          task_id: "cell-a",
          files_touched: [file],
        },
      },
    ]);
  });

  test("coordinator feedback requires a scoped review receipt and consumes it once", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const payload = {
      review_prompt: [
        "## Files Modified",
        `- \`${file}\``,
        "",
        "## Code Changes",
        "```diff",
        `diff --git a/${file} b/${file}`,
        "@@ -1 +1 @@",
        "-old",
        "+reviewed change",
        "```",
        "",
        "## Review Criteria",
      ].join("\n"),
      context: { files_touched: [file] },
    };
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payload,
      payloadFor: (name) =>
        name === "swarm_review_feedback"
          ? { success: true }
          : name === "swarm_complete"
            ? completionVerification()
            : payload,
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-review");
    const completionInput = {
      project_key: projectPath,
      agent_name: "swarm-worker",
      bead_id: "cell-a",
      summary: "Completed and approved.",
      start_time: 1,
      files_touched: [file],
    };
    const pendingCompletion = await rig.tools.get("swarm_complete")?.execute(
      completionInput,
      workerToolContext("swarm/swarm-worker", "call-completion-pending"),
    );
    expect((pendingCompletion?.output as { status: string }).status).toBe("pending_review");
    const review = rig.tools.get("swarm_review");
    const feedback = rig.tools.get("swarm_review_feedback");
    expect(review).toBeDefined();
    expect(feedback).toBeDefined();

    await review?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-valid"),
    );
    await feedback?.execute(
      {
        project_key: projectPath,
        task_id: "cell-a",
        worker_id: "swarm/swarm-worker",
        status: "approved",
        summary: "Scoped diff reviewed.",
      },
      toolContext("swarm/swarm-coordinator", "call-feedback-valid"),
    );

    await expect(
      feedback?.execute(
        {
          project_key: projectPath,
          task_id: "cell-a",
          worker_id: "swarm/swarm-worker",
          status: "approved",
          summary: "Replay without a new review.",
        },
        toolContext("swarm/swarm-coordinator", "call-feedback-replay"),
      ),
    ).rejects.toThrow(/review receipt/);
    expect(rig.runCalls.map((call) => call.name)).toEqual([
      "swarm_review",
      "swarm_review",
      "swarm_complete",
      "swarm_review_feedback",
      "hive_cells",
    ]);
    expect(rig.runCalls[2]?.args.skip_review).toBe(true);
    expect(rig.runEnvironments).toEqual([
      { name: "swarm_review", env: { OPENCODE_SESSION_ID: SESSION } },
      { name: "swarm_review", env: { OPENCODE_SESSION_ID: SESSION } },
      { name: "swarm_complete", env: { OPENCODE_SESSION_ID: "ses-worker" } },
      { name: "swarm_review_feedback", env: { OPENCODE_SESSION_ID: SESSION } },
      { name: "hive_cells", env: { OPENCODE_SESSION_ID: SESSION } },
    ]);
  });

  test("local verification fallback closes and confirms the Hive cell in the project scope", async () => {
    const projectPath = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const file = "tests/prompts.test.ts";
    let hiveStatus = "in_progress";
    let closeCalls = 0;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-fallback", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") {
          return scopedReviewPayload(
            [file],
            `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+reviewed`,
          );
        }
        if (name === "swarm_complete") {
          return { success: false, error: "Bead not found: cell-fallback" };
        }
        if (name === "hive_close") {
          closeCalls += 1;
          hiveStatus = "closed";
          return "Closed cell-fallback: verified";
        }
        if (name === "hive_cells") {
          return {
            cells: [
              { id: "cell-fallback", status: hiveStatus },
              { id: "cell-other", status: "in_progress" },
            ],
          };
        }
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-fallback", "call-dispatch-fallback");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-fallback",
        summary: "Completed the assigned work.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-fallback"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-fallback", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-fallback"),
    );

    const feedback = await rig.tools.get("swarm_review_feedback")?.execute(
      {
        project_key: projectPath,
        task_id: "cell-fallback",
        worker_id: "swarm-worker",
        status: "approved",
        summary: "Scoped diff approved after local verification.",
      },
      toolContext("swarm/swarm-coordinator", "call-feedback-fallback"),
    );

    expect((feedback?.output as { approval_evidence: { status: string } }).approval_evidence.status).toBe(
      "approved",
    );
    expect(closeCalls).toBe(1);
    const hiveCalls = rig.runCalls.filter((call) => call.name === "hive_cells");
    expect(hiveCalls.length).toBeGreaterThanOrEqual(2);
    expect(hiveCalls.every((call) => call.args.project_key === projectPath)).toBe(true);
    expect(rig.runCalls.some((call) => call.name === "hive_close" && call.args.id === "cell-fallback")).toBe(
      true,
    );
    expect(
      rig.runWorkingDirectories
        .filter((call) => call.name === "hive_close" || call.name === "hive_cells")
        .every((call) => call.cwd === projectPath),
    ).toBe(true);
  }, 30_000);

  test("local fallback refuses approval when Hive remains in progress after close", async () => {
    const projectPath = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const file = "tests/prompts.test.ts";
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-still-open", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") {
          return scopedReviewPayload(
            [file],
            `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+reviewed`,
          );
        }
        if (name === "swarm_complete") {
          return { success: false, error: "Bead not found: cell-still-open" };
        }
        if (name === "hive_cells") {
          return {
            cells: [
              { id: "cell-still-open", status: "in_progress" },
              { id: "cell-other", status: "in_progress" },
            ],
          };
        }
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-still-open", "call-dispatch-still-open");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-still-open",
        summary: "Completed the assigned work.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-still-open"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-still-open", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-still-open"),
    );

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-still-open",
          worker_id: "swarm-worker",
          status: "approved",
          summary: "The backend closure could not be verified.",
        },
        toolContext("swarm/swarm-coordinator", "call-feedback-still-open"),
      ),
    ).rejects.toThrow(/Hive cell cell-still-open is not closed/);
    expect(rig.runCalls.some((call) => call.name === "hive_close")).toBe(true);
    expect(await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-still-open"))).toMatchObject({
      finalizing: true,
    });
    // The review was approved and local checks passed; only the backend close
    // failed. The coordinator can now close explicitly without reopening review.
    await expect(
      rig.tools.get("hive_close")?.execute(
        { id: "cell-still-open", reason: "Manual close after approved review." },
        toolContext("swarm/swarm-coordinator", "call-manual-close-still-open"),
      ),
    ).resolves.toBeDefined();
  }, 30_000);

  test("backend completion with only skipped verification steps cannot be approved", async () => {
    const projectPath = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
    const file = relative(projectPath, fileURLToPath(new URL("../bin/swarmx.ts", import.meta.url)));
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-skipped-backend", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") {
          return scopedReviewPayload(
            [file],
            `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+reviewed`,
          );
        }
        if (name === "swarm_complete") {
          return {
            success: true,
            verification_gate: {
              passed: true,
              summary: "No checks executed",
              steps: [
                { name: "typecheck", passed: true, skipped: true, skipReason: "No tsconfig.json" },
                { name: "tests", passed: true, skipped: true, skipReason: "No test files" },
              ],
            },
          };
        }
        return { success: true };
      },
    });
    await stageCellReview(rig, {
      projectPath,
      file,
      cellID: "cell-skipped-backend",
      label: "skipped-backend",
    });

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-skipped-backend",
          worker_id: "swarm-worker",
          status: "approved",
          summary: "Review passed, but verification did not run.",
        },
        toolContext("swarm/swarm-coordinator", "call-feedback-skipped-backend"),
      ),
    ).rejects.toThrow(/completion returned no verification receipt/);
    expect(rig.runCalls.some((call) => call.name === "swarm_review_feedback")).toBe(false);
  });

  test("persisted verification receipts with only skipped steps cannot be reused", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-stale-skipped-receipt", epicID: "epic-1" },
      payload: scopedReviewPayload(
        [file],
        `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+reviewed`,
      ),
    });
    await dispatchWorker(rig, "cell-stale-skipped-receipt", "call-dispatch-stale-skipped-receipt");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-stale-skipped-receipt",
        summary: "Completion awaiting review.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-stale-skipped-receipt"),
    );
    const key = pendingCompletionKey(PROJECT, "cell-stale-skipped-receipt");
    const pending = await rig.ctx.storage.get(key);
    if (typeof pending !== "object" || pending === null) throw new Error("pending completion was not stored");
    await rig.ctx.storage.set(key, {
      ...(pending as Record<string, unknown>),
      verification: {
        passed: true,
        summary: "No checks executed.",
        recordedAt: 1,
        steps: [
          { name: "typecheck", passed: true, skipped: true },
          { name: "tests", passed: true, skipped: true },
        ],
      },
    });

    await expect(
      rig.tools.get("swarm_review")?.execute(
        {
          project_key: projectPath,
          epic_id: "epic-1",
          task_id: "cell-stale-skipped-receipt",
          files_touched: [file],
        },
        toolContext("swarm/swarm-coordinator", "call-review-stale-skipped-receipt"),
      ),
    ).rejects.toThrow(/matching completion submission/);
  });

  test("local fallback with no executed checks is blocked before Hive close", async () => {
    const projectPath = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
    const file = relative(projectPath, fileURLToPath(new URL("../bin/swarmx.ts", import.meta.url)));
    let hiveStatus = "in_progress";
    let closeCalls = 0;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-skipped-local", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") {
          return scopedReviewPayload(
            [file],
            `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+reviewed`,
          );
        }
        if (name === "swarm_complete") {
          return { success: false, error: "Bead not found: cell-skipped-local" };
        }
        if (name === "hive_close") {
          closeCalls += 1;
          hiveStatus = "closed";
          return "Closed cell-skipped-local: should not happen";
        }
        if (name === "hive_cells") {
          return {
            cells: [
              { id: "cell-skipped-local", status: hiveStatus },
              { id: "cell-other", status: "in_progress" },
            ],
          };
        }
        return { success: true };
      },
    });
    await stageCellReview(rig, {
      projectPath,
      file,
      cellID: "cell-skipped-local",
      label: "skipped-local",
    });

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-skipped-local",
          worker_id: "swarm-worker",
          status: "approved",
          summary: "Review passed, but no local checks ran.",
        },
        toolContext("swarm/swarm-coordinator", "call-feedback-skipped-local"),
      ),
    ).rejects.toThrow(/completion verification gate failed/);
    expect(closeCalls).toBe(0);
    expect(await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-skipped-local"))).toMatchObject({
      finalizing: false,
    });
  });

  test("doc-only local fallback stays unverifiable but still closes Hive", async () => {
    const projectPath = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
    const file = "AGENTS.md";
    let hiveStatus = "in_progress";
    let closeCalls = 0;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-doc-only", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") {
          return scopedReviewPayload(
            [file],
            `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+reviewed`,
          );
        }
        if (name === "swarm_complete") {
          return { success: false, error: "Bead not found: cell-doc-only" };
        }
        if (name === "hive_close") {
          closeCalls += 1;
          hiveStatus = "closed";
          return "Closed cell-doc-only: reviewed documentation";
        }
        if (name === "hive_cells") {
          return {
            cells: [
              { id: "cell-doc-only", status: hiveStatus },
              { id: "cell-other", status: "in_progress" },
            ],
          };
        }
        return { success: true };
      },
    });
    await stageCellReview(rig, {
      projectPath,
      file,
      cellID: "cell-doc-only",
      label: "doc-only",
    });

    const feedback = await rig.tools.get("swarm_review_feedback")?.execute(
      {
        project_key: projectPath,
        task_id: "cell-doc-only",
        worker_id: "swarm-worker",
        status: "approved",
        summary: "Documentation diff approved as unverifiable.",
      },
      toolContext("swarm/swarm-coordinator", "call-feedback-doc-only"),
    );

    expect((feedback?.output as { status: string }).status).toBe("unverifiable");
    expect(closeCalls).toBe(1);
    expect(hiveStatus).toBe("closed");
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

  test("approved completion recovers when backend closes before local finalization is persisted", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const diffPayload = {
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
    };
    let completionCalls = 0;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") return diffPayload;
        if (name === "swarm_complete") {
          completionCalls += 1;
          return completionCalls === 1
            ? completionVerification()
            : { success: false, error: "Bead already closed: cell-a" };
        }
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-finalize-retry");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed the assigned work.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-pending-finalize-retry"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-finalize-retry"),
    );
    const originalSet = rig.ctx.storage.set.bind(rig.ctx.storage);
    let failFinalizationOnce = true;
    rig.ctx.storage.set = async (key, value) => {
      const completion = value as { finalized?: boolean } | undefined;
      if (failFinalizationOnce && key.startsWith("pending-completion%3A") && completion?.finalized === true) {
        failFinalizationOnce = false;
        throw new Error("simulated local persistence failure");
      }
      await originalSet(key, value);
    };
    const feedbackInput = {
      project_key: projectPath,
      task_id: "cell-a",
      worker_id: "swarm/swarm-worker",
      status: "approved",
      summary: "Approved after scoped review.",
    };

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        feedbackInput,
        toolContext("swarm/swarm-coordinator", "call-feedback-finalize-first"),
      ),
    ).rejects.toThrow("simulated local persistence failure");
    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-finalizing-worker", id: "call-finalizing-edit" },
        action: "edit",
        resources: [SWARMX_FILE],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked/);
    await expect(
      rig.tools.get("swarm_complete")?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          summary: "Duplicate submission during finalization.",
          start_time: 1,
          files_touched: [file],
        },
        workerToolContext("swarm/swarm-worker", "call-duplicate-finalizing-completion"),
      ),
    ).rejects.toThrow(/completion finalization is already in progress/);
    await rig.tools.get("swarm_review_feedback")?.execute(
      feedbackInput,
      toolContext("swarm/swarm-coordinator", "call-feedback-finalize-retry"),
    );

    expect(rig.runCalls.map((call) => call.name)).toEqual([
      "swarm_review",
      "swarm_review",
      "swarm_complete",
      "swarm_review",
      "swarm_complete",
      "swarm_review_feedback",
      "hive_cells",
    ]);
    await rig.tools.get("swarm_finish")?.execute({ reason: "finalized" }, toolContext());
    await expect(
      rig.ctx.permission.assert({
        sessionID: "ses-worker",
        agent: "swarm/swarm-worker",
        source: { type: "tool", messageID: "msg-finished-worker", id: "call-finished-edit" },
        action: "edit",
        resources: [SWARMX_FILE],
      }),
    ).rejects.toThrow(/worker dispatch capability is revoked/);
  });

  test("coordinator cannot approve a review without a worker completion submission", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
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
      },
    });
    const store = missionStore(rig.ctx);
    await setBudget(store, {
      projectID: PROJECT,
      sessionID: SESSION,
      mode: "dev",
      maxSpawns: 2,
      maxIterations: 2,
    });
    await setAssignment(store, PROJECT, "cell-a", "swarm/swarm-worker");
    await expect(
      rig.tools.get("swarm_review")?.execute(
        { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
        toolContext(),
      ),
    ).rejects.toThrow(/matching completion submission/);

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-a",
          worker_id: "swarm/swarm-worker",
          status: "approved",
        },
        toolContext("swarm/swarm-coordinator", "call-approval-without-completion"),
      ),
    ).rejects.toThrow(/scoped review receipt/);
    expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
  });

  test("swarm_review refuses a missing diff and cannot create an approval receipt", async () => {
    const projectPath = await realpath(process.cwd());
    const file = "nonexistent-file-xyz.ts";
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
        review_prompt: [
          "## Code Changes",
          "```diff",
          "(no diff available)",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
        context: { files_touched: [file] },
      },
    });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("swarm_review")?.execute(
        { project_key: projectPath, epic_id: "epic-1", task_id: "cell-empty", files_touched: [file] },
        toolContext("swarm/swarm-coordinator", "call-review-empty"),
      ),
    ).rejects.toThrow(/non-empty scoped diff/);
    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-empty",
          worker_id: "swarm/swarm-worker",
          status: "approved",
        },
        toolContext("swarm/swarm-coordinator", "call-feedback-empty"),
      ),
    ).rejects.toThrow(/review receipt/);
    expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
  });

  test("swarm_review refuses a truncated code-change section", async () => {
    const projectPath = await realpath(process.cwd());
    const file = "nonexistent-file-xyz.ts";
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
        review_prompt: [
          "## Files Modified",
          `- \`${file}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${file} b/${file}`,
          "+truncated",
        ].join("\n"),
        context: { files_touched: [file] },
      },
    });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("swarm_review")?.execute(
        { project_key: projectPath, epic_id: "epic-1", task_id: "cell-truncated", files_touched: [file] },
        toolContext("swarm/swarm-coordinator", "call-review-truncated"),
      ),
    ).rejects.toThrow(/non-empty scoped diff/);
    expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
  });

  test("swarm_review refuses mismatched and header-only diffs", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const cases = [
      {
        review_prompt: [
          "## Files Modified",
          `- \`${file}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${SWARMX_STATE_FILE} b/${SWARMX_STATE_FILE}`,
          "@@ -1 +1 @@",
          "+other file",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
      },
      {
        review_prompt: [
          "## Files Modified",
          `- \`${file}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${file} b/${file}`,
          "index 123..456 100644",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
      },
    ];

    for (const [index, response] of cases.entries()) {
      const rig = await createRig({
        agents: GATE_AGENTS,
        projectPath,
        payload: { ...response, context: { files_touched: [file] } },
      });
      await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());
      await expect(
        rig.tools.get("swarm_review")?.execute(
          { project_key: projectPath, epic_id: "epic-1", task_id: `cell-invalid-${index}`, files_touched: [file] },
          toolContext("swarm/swarm-coordinator", `call-review-invalid-diff-${index}`),
        ),
      ).rejects.toThrow(/scoped diff/);
      expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
    }
  });

  test("swarm_review requires a complete change section for every requested file", async () => {
    const projectPath = await realpath(process.cwd());
    const files = [SWARMX_FILE, SWARMX_STATE_FILE];
    const makePrompt = (secondFileDiff: readonly string[]): string =>
      [
        "## Files Modified",
        ...files.map((file) => `- \`${file}\``),
        "",
        "## Code Changes",
        "```diff",
        `diff --git a/${files[0]} b/${files[0]}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        `diff --git a/${files[1]} b/${files[1]}`,
        ...secondFileDiff,
        "```",
        "",
        "## Review Criteria",
      ].join("\n");
    const incompleteResponses = [
      ["index 123..456 100644"],
      ["@@ -1,2 +1,2 @@", "-old", "+new"],
    ];

    for (const [index, secondFileDiff] of incompleteResponses.entries()) {
      const rig = await createRig({
        agents: GATE_AGENTS,
        projectPath,
        payload: {
          review_prompt: makePrompt(secondFileDiff),
          context: { files_touched: files },
        },
      });
      await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

      await expect(
        rig.tools.get("swarm_review")?.execute(
          { project_key: projectPath, epic_id: "epic-1", task_id: `cell-partial-${index}`, files_touched: files },
          toolContext("swarm/swarm-coordinator", `call-review-partial-${index}`),
        ),
      ).rejects.toThrow(/non-empty scoped diff/);
      expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
    }
  });

  test("swarm_review refuses an empty diff for any files_touched entry", async () => {
    const projectPath = await realpath(process.cwd());
    const first = SWARMX_FILE;
    const second = SWARMX_STATE_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
        review_prompt: [
          "## Files Modified",
          `- \`${first}\``,
          `- \`${second}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${first} b/${first}`,
          "@@ -1 +1 @@",
          "-old",
          "+new",
          `diff --git a/${second} b/${second}`,
          "index 123..456 100644",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
        context: { files_touched: [first, second] },
      },
    });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("swarm_review")?.execute(
        {
          project_key: projectPath,
          epic_id: "epic-1",
          task_id: "cell-empty-entry",
          files_touched: [first, second],
        },
        toolContext("swarm/swarm-coordinator", "call-review-empty-entry"),
      ),
    ).rejects.toThrow(/non-empty scoped diff/);
    expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
    expect(reviewReceiptStorageKey(rig)).toBeUndefined();
  });

  test("swarm_review refuses a files_touched entry with no diff section", async () => {
    const projectPath = await realpath(process.cwd());
    const first = SWARMX_FILE;
    const second = SWARMX_STATE_FILE;
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      payload: {
        review_prompt: [
          "## Files Modified",
          `- \`${first}\``,
          `- \`${second}\``,
          "",
          "## Code Changes",
          "```diff",
          `diff --git a/${first} b/${first}`,
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "```",
          "",
          "## Review Criteria",
        ].join("\n"),
        context: { files_touched: [first, second] },
      },
    });
    await rig.tools.get("swarm_set_budget")?.execute({ mode: "dev" }, toolContext());

    await expect(
      rig.tools.get("swarm_review")?.execute(
        {
          project_key: projectPath,
          epic_id: "epic-1",
          task_id: "cell-missing-entry",
          files_touched: [first, second],
        },
        toolContext("swarm/swarm-coordinator", "call-review-missing-entry"),
      ),
    ).rejects.toThrow(/non-empty scoped diff/);
    expect(rig.runCalls.map((call) => call.name)).toEqual(["swarm_review"]);
    expect(reviewReceiptStorageKey(rig)).toBeUndefined();
  });

  test("swarm_review creates a receipt for a no-file task without calling the backend", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-no-file");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Research only, no files.",
        start_time: 1,
        files_touched: [],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-no-file"),
    );
    const review = await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [] },
      toolContext("swarm/swarm-coordinator", "call-review-no-file"),
    );
    expect(review).toBeDefined();
    expect(rig.runCalls.some((call) => call.name === "swarm_review")).toBe(false);

    const feedback = await rig.tools.get("swarm_review_feedback")?.execute(
      {
        project_key: projectPath,
        task_id: "cell-a",
        worker_id: "swarm-worker",
        status: "approved",
        summary: "Research accepted.",
      },
      toolContext("swarm/swarm-coordinator", "call-feedback-no-file"),
    );
    expect(feedback?.output).toMatchObject({
      approval_evidence: { status: "unverifiable" },
      completion: { ok: true },
    });
  });

  test("swarm_cancel_completion cancels pending and frees the cell for retry", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-cancel");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Needs correction.",
        start_time: 1,
        files_touched: [],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-cancel"),
    );
    const canceled = await rig.tools.get("swarm_cancel_completion")?.execute(
      { bead_id: "cell-a", reason: "Wrong submission; retry required." },
      toolContext("swarm/swarm-coordinator", "call-cancel"),
    );
    expect(canceled?.output).toMatchObject({ bead_id: "cell-a", canceled: true });
    expect(await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-a"))).toMatchObject({
      canceled: true,
      finalized: true,
      cancelReason: "Wrong submission; retry required.",
    });
    const marker = await dispatchWorker(rig, "cell-a", "call-dispatch-retry", "ses-worker-retry");
    expect(marker.cellID).toBe("cell-a");
  });

  test("swarm_finish abandon force-closes with pending completions", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-abandon");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Pending work.",
        start_time: 1,
        files_touched: [],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-abandon"),
    );
    const finished = await rig.tools.get("swarm_finish")?.execute(
      { reason: "Mission abandoned.", abandon: true },
      toolContext("swarm/swarm-coordinator", "call-finish-abandon"),
    );
    expect(finished?.output).toMatchObject({ finished: true, active: false });
    expect(await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-a"))).toMatchObject({
      canceled: true,
      finalized: true,
    });
  });

  test("swarm_mission_status lists stale sessions and all_sessions abandon clears them", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    const store = missionStore(rig.ctx);
    await dispatchWorker(rig, "cell-a", "call-dispatch-current");
    const staleSession = "ses-stale";
    await setBudget(store, {
      projectID: PROJECT,
      sessionID: staleSession,
      mode: "dev",
      maxSpawns: 3,
      maxIterations: 3,
      workerShare: 1,
    });
    await setAssignment(store, PROJECT, "cell-stale", "swarm/swarm-worker", { sessionID: staleSession });
    const stalePayload = {
      ...workerDispatchPayload("cell-stale", "call-dispatch-stale"),
      sessionID: staleSession,
    };
    await rig.before(stalePayload);

    const status = await rig.tools.get("swarm_mission_status")?.execute({}, toolContext());
    expect(status?.output).toMatchObject({
      missions: [
        { sessionID: SESSION, active: true },
        { sessionID: staleSession, active: true },
      ],
    });

    const finished = await rig.tools.get("swarm_finish")?.execute(
      { reason: "Clear stale missions.", abandon: true, all_sessions: true },
      toolContext("swarm/swarm-coordinator", "call-finish-all"),
    );
    expect(finished?.output).toMatchObject({
      finished: true,
      active: false,
      abandoned: [SESSION, staleSession],
    });
    expect(await readMission(store, PROJECT, SESSION)).toMatchObject({ active: false });
    expect(await readMission(store, PROJECT, staleSession)).toMatchObject({ active: false });
  });

  test("a specialized worker can submit swarm_complete before swarmmail_init", async () => {
    const agents = [
      ...GATE_AGENTS,
      {
        id: "sdp-java-developer",
        name: "sdp-java-developer",
        description: "Java backend implementation",
        mode: "subagent" as const,
        hidden: false,
        permissions: [],
      },
    ];
    const rig = await createRig({
      agents,
      projectPath: process.cwd(),
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    const store = missionStore(rig.ctx);
    await setBudget(store, {
      projectID: PROJECT,
      sessionID: SESSION,
      mode: "dev",
      maxSpawns: 3,
      maxIterations: 3,
      workerShare: 1,
    });
    await setAssignment(store, PROJECT, "cell-a", "sdp-java-developer");
    const payload = workerDispatchPayload("cell-a", "call-dispatch-java-complete");
    payload.input = {
      agent: "sdp-java-developer",
      prompt: `Implement the assigned cell.\n\n${cellMarker("cell-a")}`,
    };
    await rig.before(payload);
    const marker = extractCellMarker({ prompt: (payload.input as { prompt: string }).prompt });
    rig.bindWorkerSession("ses-java-worker", marker, SESSION);

    const completion = await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: process.cwd(),
        agent_name: "sdp-java-developer",
        bead_id: "cell-a",
        summary: "Implementation complete.",
        start_time: 1,
        files_touched: [],
      },
      workerToolContext("sdp-java-developer", "call-java-complete", "ses-java-worker"),
    );
    expect(completion?.output).toMatchObject({ status: "pending_review" });
    expect((await getAttempt(store, PROJECT, "call-dispatch-java-complete"))?.workerSessionID).toBe(
      "ses-java-worker",
    );
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

  test("swarm_complete stores worker verification steps", async () => {
    const projectPath = await realpath(process.cwd());
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-verify");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Tests pass.",
        start_time: 1,
        files_touched: [],
        verification: [
          { name: "targeted tests", command: "npm test -- --runInBand", exit_code: 0, output: "PASS" },
        ],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-verify"),
    );
    expect(await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-a"))).toMatchObject({
      verification: {
        passed: true,
        steps: [{ name: "targeted tests", command: "npm test -- --runInBand", exitCode: 0, output: "PASS", passed: true }],
      },
    });
  });

  test("swarm_review exposes the diff of a new untracked file", async () => {
    const projectPath = await realpath(await mkdtemp(join(tmpdir(), "swarmx-review-new-")));
    try {
      await writeFile(join(projectPath, "new-file.txt"), "hello\nworld\n");
      const rig = await createRig({
        agents: GATE_AGENTS,
        projectPath,
        workerCell: { cellID: "cell-a", epicID: "epic-1" },
        payload: {
          review_prompt: "## Files Modified\n\n## Code Changes\n```diff\n\n```\n\n## Review Criteria",
          context: { files_touched: [] },
        },
      });
      await dispatchWorker(rig, "cell-a", "call-dispatch-new-file");
      await rig.tools.get("swarm_complete")?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm-worker",
          bead_id: "cell-a",
          summary: "Added a new file.",
          start_time: 1,
          files_touched: ["new-file.txt"],
        },
        workerToolContext("swarm/swarm-worker", "call-completion-new-file"),
      );
      const review = await rig.tools.get("swarm_review")?.execute(
        { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: ["new-file.txt"] },
        toolContext("swarm/swarm-coordinator", "call-review-new-file"),
      );
      const prompt = (review?.output as { review_prompt?: string }).review_prompt ?? "";
      expect(prompt).toContain("new-file.txt");
      expect(prompt).toContain("+hello");
      expect(prompt).toContain("+world");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  test("approval requires a completion verification receipt", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const diff = [`diff --git a/${file} b/${file}`, "@@ -1 +1 @@", "-old", "+new"].join("\n");
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") return scopedReviewPayload([file], diff);
        // A successful close without `verification_gate` is not a receipt.
        if (name === "swarm_complete") return { success: true };
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-no-receipt");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed without a verification receipt.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-no-receipt"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-no-receipt"),
    );

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-a",
          worker_id: "swarm/swarm-worker",
          status: "approved",
          summary: "Approve despite a missing receipt.",
        },
        toolContext("swarm/swarm-coordinator", "call-approval-no-receipt"),
      ),
    ).rejects.toThrow(/verification receipt/);

    expect(rig.runCalls.filter((call) => call.name === "swarm_review_feedback")).toHaveLength(0);
    const pending = (await rig.ctx.storage.get(pendingCompletionKey(PROJECT, "cell-a"))) as
      | { finalizing?: boolean; finalized?: boolean }
      | undefined;
    expect(pending?.finalizing ?? false).toBe(false);
    expect(pending?.finalized ?? false).toBe(false);
    const reviewKey = reviewReceiptStorageKey(rig);
    expect(reviewKey).toBeDefined();
    const reviewReceipt = (await rig.ctx.storage.get(reviewKey as string)) as
      | { approval?: unknown }
      | undefined;
    expect(reviewReceipt?.approval).toBeUndefined();
  });

  test("doc-only cells can be approved as unverifiable without a verification receipt", async () => {
    const projectPath = await realpath(join(import.meta.dir, ".."));
    const file = "assets/commands/swarmx.md";
    const diff = [`diff --git a/${file} b/${file}`, "@@ -1 +1 @@", "-old", "+new"].join("\n");
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") return scopedReviewPayload([file], diff);
        // A successful close without `verification_gate` is not a receipt, but
        // doc-only cells are exempt and become unverifiable instead of blocked.
        if (name === "swarm_complete") return { success: true };
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-doc-only");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed doc-only work.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-doc-only"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-doc-only"),
    );

    const feedback = await rig.tools.get("swarm_review_feedback")?.execute(
      {
        project_key: projectPath,
        task_id: "cell-a",
        worker_id: "swarm/swarm-worker",
        status: "approved",
        summary: "Approve doc-only change.",
      },
      toolContext("swarm/swarm-coordinator", "call-approval-doc-only"),
    );

    expect((feedback?.output as { status?: string })?.status).toBe("unverifiable");
    expect((feedback?.output as { warning?: string })?.warning).toMatch(/unverifiable/i);
    expect(String(feedback?.content)).toMatch(/unverifiable/i);
  });

  test("approval evidence logs the diff hash and verification receipt", async () => {
    const projectPath = await realpath(process.cwd());
    const file = SWARMX_FILE;
    const diff = [`diff --git a/${file} b/${file}`, "@@ -1 +1 @@", "-old", "+new"].join("\n");
    const rig = await createRig({
      agents: GATE_AGENTS,
      projectPath,
      workerCell: { cellID: "cell-a", epicID: "epic-1" },
      payloadFor: (name) => {
        if (name === "swarm_review") return scopedReviewPayload([file], diff);
        if (name === "swarm_complete") return completionVerification();
        return { success: true };
      },
    });
    await dispatchWorker(rig, "cell-a", "call-dispatch-approval-evidence");
    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm-worker",
        bead_id: "cell-a",
        summary: "Completed with verification.",
        start_time: 1,
        files_touched: [file],
      },
      workerToolContext("swarm/swarm-worker", "call-completion-approval-evidence"),
    );
    await rig.tools.get("swarm_review")?.execute(
      { project_key: projectPath, epic_id: "epic-1", task_id: "cell-a", files_touched: [file] },
      toolContext("swarm/swarm-coordinator", "call-review-approval-evidence"),
    );

    const feedback = await rig.tools.get("swarm_review_feedback")?.execute(
      {
        project_key: projectPath,
        task_id: "cell-a",
        worker_id: "swarm/swarm-worker",
        status: "approved",
        summary: "Approved with evidence.",
      },
      toolContext("swarm/swarm-coordinator", "call-approval-evidence"),
    );
    const expectedHash = createHash("sha256").update(diff).digest("hex");
    const evidence = (
      feedback?.output as
        | { approval_evidence?: { diff_hash?: string; verification?: { passed?: boolean } } }
        | undefined
    )?.approval_evidence;
    expect(evidence?.diff_hash).toBe(expectedHash);
    expect(evidence?.verification?.passed).toBe(true);

    const reviewKey = reviewReceiptStorageKey(rig);
    expect(reviewKey).toBeDefined();
    const stored = (await rig.ctx.storage.get(reviewKey as string)) as
      | {
          approval?: {
            diffHash?: string;
            verification?: { passed?: boolean; steps?: readonly unknown[] };
          };
        }
      | undefined;
    expect(stored?.approval?.diffHash).toBe(expectedHash);
    expect(stored?.approval?.verification?.passed).toBe(true);
    expect((stored?.approval?.verification?.steps ?? []).length).toBeGreaterThan(0);

    await expect(
      rig.tools.get("swarm_review_feedback")?.execute(
        {
          project_key: projectPath,
          task_id: "cell-a",
          worker_id: "swarm/swarm-worker",
          status: "approved",
          summary: "Replay the consumed receipt.",
        },
        toolContext("swarm/swarm-coordinator", "call-approval-evidence-replay"),
      ),
    ).rejects.toThrow(/review receipt/);
  });

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

  test("swarm_set_budget gates a spawn and settle keeps exact counters", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    const store = missionStore(rig.ctx);

    const budgetResult = await rig.tools.get("swarm_set_budget")?.execute(
      { mode: "dev", max_spawns: 3, max_iterations: 2 },
      toolContext(),
    );
    expect(budgetResult?.output).toMatchObject({ sessionID: SESSION, active: true });

    const assignment = await rig.tools.get("swarm_set_agent")?.execute(
      { bead_id: "cell-a", agent: "ts-pro" },
      toolContext(),
    );
    expect(assignment?.output).toMatchObject({
      bead_id: "cell-a",
      agent: "development/typescript-pro",
      persisted: true,
    });

    await rig.before(beforePayload());

    let mission = await readMission(store, PROJECT, SESSION);
    expect(mission?.counts).toEqual({
      spawns: 1,
      cells: 1,
      attemptsByCell: { "cell-a": 1 },
      workerSpawns: 0,
    });
    expect((await getAttempt(store, PROJECT, "call-1"))?.status).toBe("pending");

    // Replaying the same Tool.CallID must not charge the budget twice.
    await rig.before(beforePayload());
    mission = await readMission(store, PROJECT, SESSION);
    expect(mission?.counts.spawns).toBe(1);
    expect(mission?.counts.attemptsByCell).toEqual({ "cell-a": 1 });

    await rig.after(afterPayload("completed"));
    mission = await readMission(store, PROJECT, SESSION);
    expect((await getAttempt(store, PROJECT, "call-1"))?.status).toBe("succeeded");
    expect(mission?.counts.spawns).toBe(1);

    // A duplicate execute.after is a no-op as well.
    await rig.after(afterPayload("error"));
    expect((await getAttempt(store, PROJECT, "call-1"))?.status).toBe("succeeded");
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(1);
  });

  test("execute.before is a no-op on subagent when no mission is active", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    const size = rig.ctx.storage.map.size;

    await rig.before(beforePayload());
    await rig.after(afterPayload("completed"));

    expect(rig.ctx.storage.map.size).toBe(size);
    expect(await readMission(missionStore(rig.ctx), PROJECT, SESSION)).toBeUndefined();
  });

  test("compaction pushes one factual part for an active mission only", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });
    await rig.tools.get("swarm_set_budget")?.execute(
      { mode: "dev", max_spawns: 2, max_iterations: 2 },
      toolContext(),
    );

    const event = rig.ctx.createCompactionEvent({ sessionID: SESSION });
    expect(event.system).toHaveLength(1);
    await rig.compaction(event);

    expect(event.system).toHaveLength(2);
    const part = event.system[1];
    expect(part.type).toBe("text");
    expect(part.text).toContain("<swarmx_facts>");
    expect(event.result).toBeUndefined();
  });

  test("compaction is a strict no-op without an active mission", async () => {
    const rig = await createRig({ agents: GATE_AGENTS });

    const event = rig.ctx.createCompactionEvent({ sessionID: SESSION });
    await rig.compaction(event);

    expect(event.system).toHaveLength(1);
    expect(event.result).toBeUndefined();
  });
});
