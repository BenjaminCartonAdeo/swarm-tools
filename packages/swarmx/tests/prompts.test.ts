/**
 * Subtask prompt rendering and local tool handlers (Task 5).
 *
 * The prompt contract is strict: one exact cell marker, one protocol injection
 * at most, deterministic output and explicit refusals. The handler tests drive
 * the seven local tools through a fake V2 context and the real mission store.
 */
import { realpath } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

import { consolidationCreateArgs, findToolSpec, registerTools } from "../src/catalog";
import {
  countOccurrences,
  renderSubtaskPrompt,
  RenderPromptError,
  WORKER_PROTOCOL_FALLBACK,
  type RenderPromptInput,
} from "../src/roster";
import {
  assignmentKey,
  budgetKey,
  completeConsolidation,
  createMissionStateStore,
  maybePrepareConsolidation,
  putAttempt,
  readMission,
  resetMission,
  resolveAssignment,
} from "../src/state";
import type { ConsolidationStatus, SwarmxRuntime, ToolContextLike } from "../src/types";
import { createFakeContext, type FakeAgentInfo, type FakeToolInfo } from "./helpers";

const MARKER = "<!-- swarmx:cell=cell-1; epic=epic-1 -->";

function markerCount(text: string): number {
  return text.split("<!-- swarmx:cell=").length - 1;
}

function promptInput(overrides: Partial<RenderPromptInput> = {}): RenderPromptInput {
  return {
    cellID: "cell-1",
    epicID: "epic-1",
    agent: "typescript-pro",
    title: "Implement the endpoint",
    description: "Add the handler and its tests.",
    files: ["src/handler.ts", "tests/handler.test.ts"],
    ...overrides,
  };
}

describe("renderSubtaskPrompt", () => {
  test("inserts the exact marker exactly once", () => {
    const prompt = renderSubtaskPrompt(promptInput());
    expect(prompt).toContain(MARKER);
    expect(markerCount(prompt)).toBe(1);
  });

  test("removes a pre-existing marker before inserting the canonical one", () => {
    const prompt = renderSubtaskPrompt(
      promptInput({
        description: `Already marked ${MARKER} here.\nAdd the handler.`,
      }),
    );
    expect(markerCount(prompt)).toBe(1);
    expect(prompt).toContain(MARKER);
    expect(prompt.indexOf(MARKER)).toBe(0);
  });

  test("injects the protocol at most once and does not reinject it", () => {
    const protocol = "1. Read the cell. 2. Run the tests.";
    const fresh = renderSubtaskPrompt(promptInput({ protocol }));
    expect(fresh.split(protocol)).toHaveLength(2);

    const already = renderSubtaskPrompt(
      promptInput({ description: `Do the work.\n${protocol}`, protocol }),
    );
    expect(already.split(protocol)).toHaveLength(2);
  });

  test("deduplicates repeated protocol occurrences", () => {
    const protocol = "WORKER PROTOCOL";
    const prompt = renderSubtaskPrompt(
      promptInput({ description: `${protocol}\nbody\n${protocol}\n${protocol}`, protocol }),
    );
    expect(prompt.split(protocol)).toHaveLength(2);
  });

  test("collapses protocol duplicates across title, description and shared context", () => {
    const protocol = "WORKER PROTOCOL";
    const prompt = renderSubtaskPrompt(
      promptInput({
        title: `Implement ${protocol}`,
        description: `${protocol}\nbody`,
        sharedContext: `context\n${protocol}`,
        protocol,
      }),
    );
    expect(countOccurrences(prompt, protocol)).toBe(1);
    expect(prompt.indexOf(protocol)).toBeGreaterThan(prompt.indexOf("# Subtask"));
  });

  test("a missing protocol resolves to the fail-closed instruction exactly once", () => {
    for (const protocol of [undefined, "", "   \n\t "]) {
      const prompt = renderSubtaskPrompt(promptInput({ protocol }));
      expect(countOccurrences(prompt, WORKER_PROTOCOL_FALLBACK)).toBe(1);
      expect(prompt.endsWith(WORKER_PROTOCOL_FALLBACK)).toBe(true);
      expect(prompt).toContain("stop and report the blocker");
    }
  });

  test("refuses an empty description, files, cellID or epicID", () => {
    expect(() => renderSubtaskPrompt(promptInput({ description: "   " }))).toThrow(
      RenderPromptError,
    );
    expect(() => renderSubtaskPrompt(promptInput({ files: [] }))).toThrow(RenderPromptError);
    expect(() => renderSubtaskPrompt(promptInput({ files: ["  "] }))).toThrow(RenderPromptError);
    expect(() => renderSubtaskPrompt(promptInput({ cellID: "" }))).toThrow(RenderPromptError);
    expect(() => renderSubtaskPrompt(promptInput({ epicID: "  " }))).toThrow(RenderPromptError);
  });

  test("is stable across identical calls", () => {
    const first = renderSubtaskPrompt(promptInput());
    const second = renderSubtaskPrompt(promptInput());
    expect(second).toBe(first);
  });
});

function fakeAgent(id: string, overrides: Partial<FakeAgentInfo> = {}): FakeAgentInfo {
  return {
    id,
    name: id,
    description: "",
    mode: "subagent",
    hidden: false,
    permissions: [],
    ...overrides,
  } as FakeAgentInfo;
}

const HANDLER_AGENTS: readonly FakeAgentInfo[] = [
  fakeAgent("swarm/swarm-worker", { name: "swarm-worker", description: "Dispatched subtask worker" }),
  fakeAgent("development/typescript-pro", {
    name: "typescript-pro",
    description: "TypeScript backend services with strict typing",
  }),
  fakeAgent("vue", { description: "Vue single file components" }),
  fakeAgent("fast", { description: "Fast read-only exploration tier" }),
  fakeAgent("medium", { description: "Medium implementation tier" }),
  fakeAgent("heavy", { description: "Heavy architecture and debugging tier" }),
  fakeAgent("swarm/swarm-coordinator", {
    name: "swarm-coordinator",
    mode: "primary",
    description: "Primary swarm coordinator",
  }),
  fakeAgent("internal-helper", { hidden: true, description: "Hidden helper" }),
];

const CALL_CONTEXT = {
  sessionID: "ses_test",
  agent: "swarm/swarm-coordinator",
  messageID: "msg-test",
  id: "call-test",
} as const;

interface Harness {
  readonly editor: ReturnType<ReturnType<typeof createFakeContext>["createEditor"]>;
  readonly store: ReturnType<typeof createMissionStateStore>;
  readonly tool: (name: string) => FakeToolInfo;
}

async function setup(overrides: Partial<SwarmxRuntime> = {}): Promise<Harness> {
  const ctx = createFakeContext({ agents: HANDLER_AGENTS });
  const store = createMissionStateStore(ctx.storage, { projectID: "adeo" });
  const runtime: SwarmxRuntime = {
    runTool: () => Promise.resolve({}),
    listAgents: () => ctx.agent.list(),
    store,
    projectID: "adeo",
    sessionID: "ses_test",
    ...overrides,
  };

  await registerTools(ctx as unknown as ToolContextLike, runtime);
  const transform = ctx.captures.toolTransforms[0];
  const editor = ctx.createEditor();
  transform(editor);

  return {
    editor,
    store,
    tool(name) {
      const found = editor.get(name);
      if (found === undefined) throw new Error(`missing tool ${name}`);
      return found;
    },
  };
}

async function outputOf(tool: FakeToolInfo, input: unknown): Promise<Record<string, unknown>> {
  const result = await tool.execute(input, CALL_CONTEXT);
  return result.output as Record<string, unknown>;
}

describe("local tool handlers", () => {
  test("swarm_roster lists only dispatchable agents", async () => {
    const { tool } = await setup();
    const output = await outputOf(tool("swarm_roster"), {});
    const agents = output.agents as readonly { id: string }[];
    expect(agents.map((entry) => entry.id)).toEqual([
      "development/typescript-pro",
      "fast",
      "heavy",
      "medium",
      "swarm/swarm-worker",
      "vue",
    ]);
    expect(output.count).toBe(6);
    expect(output.total).toBe(8);
  });

  test("swarm_resolve_agent honors an explicit tier when its agent exists", async () => {
    const { tool, store } = await setup();
    const cells = [
      { bead_id: "cell-heavy", title: "Design the migration", tier: "heavy" },
      { bead_id: "cell-fast", title: "Locate the auth flow", tier: "fast" },
    ];

    const output = await outputOf(tool("swarm_resolve_agent"), { cells, apply: true });
    const results = output.results as readonly { bead_id: string; agent: string | null; rationale: string }[];
    expect(results.find((entry) => entry.bead_id === "cell-heavy")?.agent).toBe("heavy");
    expect(results.find((entry) => entry.bead_id === "cell-fast")?.agent).toBe("fast");
    expect(results[0]?.rationale).toContain("explicit tier heavy");
    expect(await resolveAssignment(store, "adeo", "cell-heavy")).toBe("heavy");
    expect(await resolveAssignment(store, "adeo", "cell-fast")).toBe("fast");
    expect(await store.storage.get(assignmentKey("adeo", "cell-heavy"))).toMatchObject({
      sessionID: "ses_test",
    });
  });

  test("swarm_resolve_agent rejects an unknown tier value", async () => {
    const { tool } = await setup();
    await expect(
      tool("swarm_resolve_agent").execute(
        { cells: [{ title: "x", tier: "ultra" }] },
        CALL_CONTEXT,
      ),
    ).rejects.toThrow(/tier must be fast, medium, or heavy/);
  });

  test("swarm_resolve_agent falls back to lexical resolution when the tier agent is absent", async () => {
    const ctx = createFakeContext({ agents: HANDLER_AGENTS.filter((agent) => agent.id !== "heavy") });
    const store = createMissionStateStore(ctx.storage, { projectID: "adeo" });
    const runtime: SwarmxRuntime = {
      runTool: () => Promise.resolve({}),
      listAgents: () => ctx.agent.list(),
      store,
      projectID: "adeo",
      sessionID: "ses_test",
    };
    await registerTools(ctx as unknown as ToolContextLike, runtime);
    const editor = ctx.createEditor();
    ctx.captures.toolTransforms[0]?.(editor);
    const tool = editor.get("swarm_resolve_agent");
    if (tool === undefined) throw new Error("missing swarm_resolve_agent");

    const result = await tool.execute(
      { cells: [{ title: "Design the migration", tier: "heavy", files: ["src/a.ts"] }] },
      CALL_CONTEXT,
    );
    const results = (result.output as { results: readonly { agent: string | null }[] }).results;
    expect(results[0]?.agent).not.toBe("heavy");
  });

  test("swarm_resolve_agent is deterministic and persists assignments on apply", async () => {
    const { tool, store } = await setup();
    const cells = [{ bead_id: "cell-ts", title: "Implement endpoint", files: ["src/a.ts"] }];

    const first = await outputOf(tool("swarm_resolve_agent"), { cells });
    const second = await outputOf(tool("swarm_resolve_agent"), { cells });
    expect(second).toEqual(first);

    const results = first.results as readonly { agent: string | null }[];
    expect(results[0]?.agent).toBe("development/typescript-pro");

    await outputOf(tool("swarm_resolve_agent"), { cells, apply: true });
    expect(await resolveAssignment(store, "adeo", "cell-ts")).toBe("development/typescript-pro");
  });

  test("swarm_resolve_agent reports arbitration instead of defaulting", async () => {
    const { tool } = await setup();
    const output = await outputOf(tool("swarm_resolve_agent"), {
      cells: [{ bead_id: "cell-x", title: "Zzz qqq", files: [] }],
    });
    const results = output.results as readonly {
      agent: string | null;
      needs_arbitration: boolean;
      candidates: readonly string[];
    }[];
    expect(results[0]?.agent).toBeNull();
    expect(results[0]?.needs_arbitration).toBe(true);
    expect(results[0]?.candidates).toEqual([]);
  });

  test("swarm_set_agent stores the assignment and rejects unknown agents", async () => {
    const { tool, store } = await setup();
    const output = await outputOf(tool("swarm_set_agent"), {
      bead_id: "cell-vue",
      agent: "vue",
      rationale: "UI work",
    });
    expect(output.agent).toBe("vue");
    expect(await resolveAssignment(store, "adeo", "cell-vue")).toBe("vue");
    expect(await store.storage.get(assignmentKey("adeo", "cell-vue"))).toMatchObject({
      sessionID: "ses_test",
    });

    const failure = tool("swarm_set_agent").execute(
      { bead_id: "cell-vue", agent: "ghost" },
      CALL_CONTEXT,
    );
    await expect(failure).rejects.toThrow(/agent_unknown/);
  });

  test("swarm_set_budget creates the mission and refuses a second budget", async () => {
    const { tool } = await setup();
    const first = await outputOf(tool("swarm_set_budget"), {});
    expect(first.budget).toEqual({ maxSpawns: 20, maxIterations: 3, workerShare: 0.2 });
    expect(first.active).toBe(true);

    const second = tool("swarm_set_budget").execute({}, CALL_CONTEXT);
    await expect(second).rejects.toThrow(/already set/);
  });

  test("swarm_subtask_prompt embeds the marker exactly once and keeps the agent", async () => {
    const { tool } = await setup();
    const output = await outputOf(tool("swarm_subtask_prompt"), {
      agent_name: "development/typescript-pro",
      bead_id: "cell-1",
      epic_id: "epic-1",
      subtask_title: "Implement the endpoint",
      subtask_description: "Add the handler and its tests.",
      files: ["src/handler.ts"],
    });
    expect(output.agent).toBe("development/typescript-pro");
    const prompt = output.prompt as string;
    expect(markerCount(prompt)).toBe(1);
    expect(prompt).toContain(MARKER);
  });

  test("swarm_subtask_prompt fails closed when no worker protocol is wired", async () => {
    for (const workerProtocol of [undefined, "", "  \n "]) {
      const { tool } = await setup({ workerProtocol });
      const output = await outputOf(tool("swarm_subtask_prompt"), {
        agent_name: "development/typescript-pro",
        bead_id: "cell-1",
        epic_id: "epic-1",
        subtask_title: "Implement the endpoint",
        subtask_description: "Add the handler and its tests.",
        files: ["src/handler.ts"],
      });
      const prompt = output.prompt as string;
      expect(countOccurrences(prompt, WORKER_PROTOCOL_FALLBACK)).toBe(1);
      expect(prompt).toContain("stop and report the blocker");
      expect(markerCount(prompt)).toBe(1);
    }
  });

  test("swarm_subtask_prompt injects the wired protocol exactly once even when duplicated", async () => {
    const protocol = "WORKER PROTOCOL";
    const { tool } = await setup({ workerProtocol: protocol });
    const output = await outputOf(tool("swarm_subtask_prompt"), {
      agent_name: "development/typescript-pro",
      bead_id: "cell-1",
      epic_id: "epic-1",
      subtask_title: `Implement ${protocol}`,
      subtask_description: `${protocol}\nAdd the handler.\n${protocol}`,
      shared_context: `context ${protocol}`,
      files: ["src/handler.ts"],
    });
    const prompt = output.prompt as string;
    expect(countOccurrences(prompt, protocol)).toBe(1);
    expect(prompt).not.toContain(WORKER_PROTOCOL_FALLBACK);
  });

  test("swarm_spawn_retry rejects a retry without a root cause", async () => {
    const calls: string[] = [];
    const { tool } = await setup({
      runTool: (name) => {
        calls.push(name);
        return Promise.resolve({});
      },
    });
    const retryArgs = {
      bead_id: "cell-1",
      epic_id: "epic-1",
      original_prompt: "Implement the endpoint",
      attempt: 1,
      issues: "[]",
      files: ["src/handler.ts"],
    };

    await expect(tool("swarm_spawn_retry").execute(retryArgs, CALL_CONTEXT)).rejects.toThrow(
      /failure_reason, failed_command or error_excerpt/,
    );

    for (const blank of ["", "   \n\t "]) {
      await expect(
        tool("swarm_spawn_retry").execute({ ...retryArgs, failure_reason: blank }, CALL_CONTEXT),
      ).rejects.toThrow(/retry refused/);
    }
    expect(calls).toEqual([]);
  });

  test("swarm_spawn_retry injects the root cause into the prompt and records it", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const { tool, store } = await setup({
      runTool: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve(
          JSON.stringify({ prompt: "⚠️ RETRY ATTEMPT 1/3\n\n## ORIGINAL TASK\nDo the thing." }),
        );
      },
    });
    await outputOf(tool("swarm_set_budget"), {});

    const output = await outputOf(tool("swarm_spawn_retry"), {
      bead_id: "cell-1",
      epic_id: "epic-1",
      original_prompt: "Implement the endpoint",
      attempt: 1,
      issues: "[]",
      files: ["src/handler.ts"],
      failure_reason: "TypeError: handler is not a function",
      failed_command: "bun test tests/handler.test.ts",
      error_excerpt: "error: expect(received).toBe(expected)",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("swarm_spawn_retry");
    expect(calls[0]?.args).not.toHaveProperty("failure_reason");
    expect(calls[0]?.args).not.toHaveProperty("failed_command");
    expect(calls[0]?.args).not.toHaveProperty("error_excerpt");

    const prompt = output.prompt as string;
    expect(prompt).toContain("## ORIGINAL TASK");
    expect(prompt).toContain("## ROOT CAUSE");
    expect(prompt).toContain("TypeError: handler is not a function");
    expect(prompt).toContain("bun test tests/handler.test.ts");
    expect(prompt).toContain("error: expect(received).toBe(expected)");

    const mission = await store.load("adeo", "ses_test");
    expect(mission?.retryCauses?.[0]).toMatchObject({
      cellID: "cell-1",
      epicID: "epic-1",
      attempt: 1,
      failureReason: "TypeError: handler is not a function",
      failedCommand: "bun test tests/handler.test.ts",
      errorExcerpt: "error: expect(received).toBe(expected)",
    });
  });

  test("swarm_agent_audit reports the mission, then swarm_finish closes it", async () => {
    const { tool } = await setup();
    await outputOf(tool("swarm_set_budget"), { mode: "audit" });

    const auditBefore = await outputOf(tool("swarm_agent_audit"), {});
    expect(auditBefore.active).toBe(true);
    expect(auditBefore.workerSpawns).toBe(0);
    expect(auditBefore.workerShare).toBe(0);

    const finished = await outputOf(tool("swarm_finish"), { reason: "done" });
    expect(finished.finished).toBe(true);
    expect(finished.active).toBe(false);

    const auditAfter = await outputOf(tool("swarm_agent_audit"), {});
    expect(auditAfter.active).toBe(false);
  });

  test("swarm_reset clears the mission and allows a new budget", async () => {
    const { tool } = await setup();
    await outputOf(tool("swarm_set_budget"), { mode: "audit" });

    const reset = await outputOf(tool("swarm_reset"), {});
    expect(reset.reset).toBe(true);

    const auditAfter = await outputOf(tool("swarm_agent_audit"), {});
    expect(auditAfter.active).toBe(false);

    const newBudget = await outputOf(tool("swarm_set_budget"), { mode: "dev" });
    expect((newBudget.budget as { maxSpawns: number }).maxSpawns).toBe(20);
  });

  test("swarm_finish clears the budget and allows a new budget", async () => {
    const { tool } = await setup();
    await outputOf(tool("swarm_set_budget"), { mode: "audit" });
    await outputOf(tool("swarm_finish"), { reason: "done" });

    const newBudget = await outputOf(tool("swarm_set_budget"), { mode: "dev" });
    expect((newBudget.budget as { maxSpawns: number }).maxSpawns).toBe(20);
  });

  test("resetMission clears the budget document", async () => {
    const PROJECT = "adeo";
    const SESSION = "ses_test";
    const { store } = await setup();
    await store.storage.set(budgetKey(PROJECT, SESSION), { maxSpawns: 5 });
    expect(await store.storage.get(budgetKey(PROJECT, SESSION))).toBeDefined();

    await resetMission(store, { projectID: PROJECT, sessionID: SESSION });
    expect(await store.storage.get(budgetKey(PROJECT, SESSION))).toBeUndefined();
  });

  test("swarm_agent_audit counts canonical and legacy worker IDs", async () => {
    const { tool, store } = await setup();
    await outputOf(tool("swarm_set_budget"), { mode: "audit" });

    const mission = await store.load("adeo", "ses_test");
    if (mission === undefined) throw new Error("swarm_set_budget did not create a mission");
    mission.counts.spawns = 2;
    mission.counts.cells = 2;
    mission.counts.attemptsByCell = { "cell-worker": 1, "cell-worker-legacy": 1 };
    mission.counts.workerSpawns = 2;
    await store.save(mission);
    await putAttempt(store, "adeo", {
      callID: "call-worker",
      missionID: mission.missionID,
      sessionID: "ses_test",
      cellID: "cell-worker",
      epicID: "epic-1",
      agent: "swarm/swarm-worker",
      status: "succeeded",
      ts: "2026-01-01T00:00:00.000Z",
    });
    await putAttempt(store, "adeo", {
      callID: "call-worker-legacy",
      missionID: mission.missionID,
      sessionID: "ses_test",
      cellID: "cell-worker-legacy",
      epicID: "epic-1",
      agent: "swarm-worker",
      status: "succeeded",
      ts: "2026-01-01T00:00:01.000Z",
    });

    const output = await outputOf(tool("swarm_agent_audit"), {});

    expect(output.workerSpawns).toBe(2);
    expect(output.workerShare).toBe(1);
  });

  test("swarm_finish refuses when no mission exists", async () => {
    const { tool } = await setup();
    const failure = tool("swarm_finish").execute({}, CALL_CONTEXT);
    await expect(failure).rejects.toThrow(/not_found/);
  });
});

describe("consolidation detection", () => {
  const EPIC = "epic-1";
  const SCOPE = { projectID: "adeo", sessionID: "ses_test", epicID: EPIC } as const;

  /** Starts a mission so `maybePrepareConsolidation` has somewhere to persist. */
  async function setupMission() {
    const harness = await setup();
    await outputOf(harness.tool("swarm_set_budget"), {});
    return harness;
  }

  test("creates the consolidation cell as a child of the epic", () => {
    expect(
      consolidationCreateArgs({
        title: `Consolidate ${EPIC}`,
        description: "Merge and verify.",
        epicID: EPIC,
      }),
    ).toEqual({
      title: `Consolidate ${EPIC}`,
      type: "task",
      description: "Merge and verify.",
      parent_id: EPIC,
    });
  });

  test("hive_create and hive_cells advertise the parent_id filter", () => {
    // Both args exist in the backend schema
    // (opencode-swarm-plugin/src/hive.ts); the catalog must mirror them or the
    // consolidation flow would forward an arg the spec denies.
    for (const name of ["hive_create", "hive_cells"]) {
      const spec = findToolSpec(name);
      if (spec === undefined) throw new Error(`missing tool spec ${name}`);
      const properties = spec.inputSchema.properties;
      expect(properties).toBeDefined();
      expect(Object.keys(properties as Record<string, unknown>)).toContain("parent_id");
    }
  });

  test("all epic cells finished prepares exactly one consolidation cell", async () => {
    const { store } = await setupMission();
    const prepared: string[][] = [];

    const consolidation = await maybePrepareConsolidation(store, {
      ...SCOPE,
      listCells: async () => [
        { id: "cell-a", status: "closed", title: "A" },
        { id: "cell-b", status: "completed", title: "B" },
      ],
      prepareCell: async (cells) => {
        prepared.push(cells.map((cell) => cell.id));
        return { cellID: "cell-consolidate", prompt: "merge and verify" };
      },
    });

    expect(prepared).toEqual([["cell-a", "cell-b"]]);
    expect(consolidation).toMatchObject({
      epicID: EPIC,
      cellID: "cell-consolidate",
      status: "ready",
      prompt: "merge and verify",
    });
    const persisted = await readMission(store, "adeo", "ses_test");
    expect(persisted?.consolidation).toEqual(consolidation);
  });

  test("one in_progress cell prepares nothing", async () => {
    const { store } = await setupMission();
    let calls = 0;

    const consolidation = await maybePrepareConsolidation(store, {
      ...SCOPE,
      listCells: async () => [
        { id: "cell-a", status: "closed" },
        { id: "cell-b", status: "in_progress" },
      ],
      prepareCell: async () => {
        calls += 1;
        return { cellID: "cell-consolidate", prompt: "merge and verify" };
      },
    });

    expect(consolidation).toBeUndefined();
    expect(calls).toBe(0);
    expect((await readMission(store, "adeo", "ses_test"))?.consolidation).toBeUndefined();
  });

  test("an existing consolidation is never duplicated", async () => {
    const { store } = await setupMission();
    let calls = 0;
    const prepareCell = async () => {
      calls += 1;
      return { cellID: `cell-consolidate-${calls}`, prompt: "merge and verify" };
    };

    const first = await maybePrepareConsolidation(store, {
      ...SCOPE,
      listCells: async () => [{ id: "cell-a", status: "closed" }],
      prepareCell,
    });
    const second = await maybePrepareConsolidation(store, {
      ...SCOPE,
      listCells: async () => [{ id: "cell-a", status: "closed" }],
      prepareCell,
    });

    expect(first?.cellID).toBe("cell-consolidate-1");
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect((await readMission(store, "adeo", "ses_test"))?.consolidation).toEqual(first);
  });

  test("an epic without children prepares nothing", async () => {
    const { store } = await setupMission();

    const consolidation = await maybePrepareConsolidation(store, {
      ...SCOPE,
      listCells: async () => [],
      prepareCell: async () => {
        throw new Error("must not prepare an empty epic");
      },
    });

    expect(consolidation).toBeUndefined();
  });
});

describe("consolidation completion", () => {
  const EPIC = "epic-1";
  const CONSOLIDATION_CELL = "cell-consolidate";

  async function setupMission() {
    const harness = await setup();
    await outputOf(harness.tool("swarm_set_budget"), {});
    const mission = await readMission(harness.store, "adeo", "ses_test");
    if (mission === undefined) throw new Error("mission was not created");
    await harness.store.save({
      ...mission,
      consolidation: {
        epicID: EPIC,
        cellID: CONSOLIDATION_CELL,
        status: "dispatched",
        prompt: "merge and verify",
        createdAt: 1_700_000_000_000,
      },
    });
    return harness;
  }

  test("approving the consolidation cell marks the epic consolidated", async () => {
    const { store } = await setupMission();

    const completed = await completeConsolidation(store, {
      projectID: "adeo",
      sessionID: "ses_test",
      cellID: CONSOLIDATION_CELL,
    });

    expect(completed?.status).toBe("completed");
    expect((await readMission(store, "adeo", "ses_test"))?.consolidation?.status).toBe("completed");
  });

  test("approving any other cell leaves the consolidation untouched", async () => {
    const { store } = await setupMission();

    const completed = await completeConsolidation(store, {
      projectID: "adeo",
      sessionID: "ses_test",
      cellID: "cell-a",
    });

    expect(completed).toBeUndefined();
    expect((await readMission(store, "adeo", "ses_test"))?.consolidation?.status).toBe("dispatched");
  });

  test("completing an already completed consolidation is idempotent", async () => {
    const { store } = await setupMission();
    const input = { projectID: "adeo", sessionID: "ses_test", cellID: CONSOLIDATION_CELL };

    const first = await completeConsolidation(store, input);
    const second = await completeConsolidation(store, input);

    expect(first).toEqual(second);
    expect(second?.status).toBe("completed");
  });

  test("a mission without consolidation is a no-op", async () => {
    const harness = await setup();
    await outputOf(harness.tool("swarm_set_budget"), {});

    const completed = await completeConsolidation(harness.store, {
      projectID: "adeo",
      sessionID: "ses_test",
      cellID: CONSOLIDATION_CELL,
    });

    expect(completed).toBeUndefined();
  });
});

describe("consolidation in swarm_agent_audit", () => {
  const EPIC = "epic-1";

  /** Starts a mission and forces its persisted consolidation pointer. */
  async function seedConsolidation(
    store: ReturnType<typeof createMissionStateStore>,
    status: ConsolidationStatus,
  ): Promise<void> {
    const mission = await readMission(store, "adeo", "ses_test");
    if (mission === undefined) throw new Error("mission was not created");
    await store.save({
      ...mission,
      consolidation: {
        epicID: EPIC,
        cellID: "cell-consolidate",
        status,
        prompt: "merge and verify",
        createdAt: 1_700_000_000_000,
      },
    });
  }

  test("a mission without consolidation audits as null", async () => {
    const { tool } = await setup();
    await outputOf(tool("swarm_set_budget"), {});

    const audit = await outputOf(tool("swarm_agent_audit"), {});

    expect(audit.consolidation).toBeNull();
  });

  test("the audit exposes the prepared prompt so the coordinator can dispatch it", async () => {
    const { tool, store } = await setup();
    await outputOf(tool("swarm_set_budget"), {});
    await seedConsolidation(store, "ready");

    const audit = await outputOf(tool("swarm_agent_audit"), {});

    expect(audit.consolidation).toEqual({
      status: "ready",
      cellID: "cell-consolidate",
      epicID: EPIC,
      prompt: "merge and verify",
    });
  });

  test("a completed consolidation audits as completed with no dispatch hint", async () => {
    const { tool, store } = await setup();
    await outputOf(tool("swarm_set_budget"), {});
    await seedConsolidation(store, "completed");

    const audit = await outputOf(tool("swarm_agent_audit"), {});

    expect((audit.consolidation as { status: string }).status).toBe("completed");
  });
});

describe("swarm_finish consolidation guard", () => {
  const EPIC = "epic-1";

  /** Rig whose `hive_cells` returns `children` (other tools answer `{}`). */
  async function setupFinish(
    children: readonly { id: string; status: string }[] | Error,
  ): Promise<Harness> {
    return setup({
      runTool: (name: string) =>
        name === "hive_cells"
          ? children instanceof Error
            ? Promise.reject(children)
            : Promise.resolve({ cells: children })
          : Promise.resolve({}),
    });
  }

  /** Ledger entry carrying an epic but no open work (status `failed`). */
  async function seedAttempt(
    store: ReturnType<typeof createMissionStateStore>,
    cellID: string,
  ): Promise<void> {
    const mission = await readMission(store, "adeo", "ses_test");
    if (mission === undefined) throw new Error("mission was not created");
    await putAttempt(store, "adeo", {
      callID: `call-${cellID}`,
      ...(mission.missionID === undefined ? {} : { missionID: mission.missionID }),
      sessionID: "ses_test",
      cellID,
      epicID: EPIC,
      agent: "swarm/swarm-worker",
      status: "failed",
      ts: new Date().toISOString(),
    });
  }

  async function seedConsolidation(
    store: ReturnType<typeof createMissionStateStore>,
    status: ConsolidationStatus,
  ): Promise<void> {
    const mission = await readMission(store, "adeo", "ses_test");
    if (mission === undefined) throw new Error("mission was not created");
    await store.save({
      ...mission,
      consolidation: {
        epicID: EPIC,
        cellID: "cell-consolidate",
        status,
        prompt: "merge and verify",
        createdAt: 1_700_000_000_000,
      },
    });
  }

  test("refuses to finish a multi-cell epic with no consolidation", async () => {
    const harness = await setupFinish([
      { id: "cell-a", status: "closed" },
      { id: "cell-b", status: "closed" },
    ]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");

    await expect(
      harness.tool("swarm_finish").execute({ reason: "done" }, CALL_CONTEXT),
    ).rejects.toThrow(/consolidation required/);
    expect((await readMission(harness.store, "adeo", "ses_test"))?.active).toBe(true);
  });

  test("refuses to finish while the consolidation is only ready", async () => {
    const harness = await setupFinish([
      { id: "cell-a", status: "closed" },
      { id: "cell-b", status: "closed" },
      { id: "cell-consolidate", status: "open" },
    ]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");
    await seedConsolidation(harness.store, "ready");

    await expect(
      harness.tool("swarm_finish").execute({ reason: "done" }, CALL_CONTEXT),
    ).rejects.toThrow(/status=ready/);
  });

  test("allows finishing once the consolidation is completed", async () => {
    const harness = await setupFinish([
      { id: "cell-a", status: "closed" },
      { id: "cell-b", status: "closed" },
      { id: "cell-consolidate", status: "closed" },
    ]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");
    await seedConsolidation(harness.store, "completed");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
  });

  test("allows finishing a single-cell epic without consolidation", async () => {
    const harness = await setupFinish([{ id: "cell-a", status: "closed" }]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
  });

  test("does not count the consolidation cell itself as work", async () => {
    // One real cell plus the prepared consolidation cell: still a single-cell
    // epic, so the guard must not demand a finished consolidation.
    const harness = await setupFinish([
      { id: "cell-a", status: "closed" },
      { id: "cell-consolidate", status: "open" },
    ]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");
    await seedConsolidation(harness.store, "ready");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
  });

  test("an unreadable hive does not block the finish", async () => {
    const harness = await setupFinish(new Error("hive unavailable"));
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
  });

  test("a consolidation cell closed in the hive counts as completed", async () => {
    const harness = await setupFinish([
      { id: "cell-a", status: "closed" },
      { id: "cell-b", status: "closed" },
      { id: "cell-consolidate", status: "closed" },
    ]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");
    // Persisted pointer still says `dispatched`: the hive status wins.
    await seedConsolidation(harness.store, "dispatched");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
  });

  test("finishing an already finished mission stays a no-op", async () => {
    const harness = await setupFinish([{ id: "cell-a", status: "closed" }]);
    await outputOf(harness.tool("swarm_set_budget"), {});
    await seedAttempt(harness.store, "cell-a");
    await outputOf(harness.tool("swarm_finish"), { reason: "guarded" });

    // The guard must not re-run on an inactive mission, otherwise the second
    // call (a legitimate retry) would be refused forever.
    const again = await outputOf(harness.tool("swarm_finish"), { reason: "retry" });

    expect(again.finished).toBe(true);
  });
});

describe("swarm_finish worktree cleanup", () => {
  type CleanupCall = { readonly name: string; readonly args: Record<string, unknown> };

  async function startMissionWithProject(
    runTool: NonNullable<SwarmxRuntime["runTool"]>,
  ): Promise<{ readonly harness: Harness; readonly projectRoot: string }> {
    const projectRoot = await realpath(process.cwd());
    const harness = await setup({ projectPath: projectRoot, runTool });
    await outputOf(harness.tool("swarm_set_budget"), {});
    return { harness, projectRoot };
  }

  async function seedFailedAttempt(
    store: ReturnType<typeof createMissionStateStore>,
    callID: string,
    cellID: string,
  ): Promise<void> {
    const mission = await readMission(store, "adeo", "ses_test");
    if (mission === undefined) throw new Error("mission was not created");
    await putAttempt(store, "adeo", {
      callID,
      ...(mission.missionID === undefined ? {} : { missionID: mission.missionID }),
      sessionID: "ses_test",
      cellID,
      agent: "swarm/swarm-worker",
      status: "failed",
      ts: new Date().toISOString(),
    });
  }

  test("cleans each task worktree with the canonical project root", async () => {
    const calls: CleanupCall[] = [];
    const { harness, projectRoot } = await startMissionWithProject((name, args) => {
      if (name === "swarm_worktree_cleanup") calls.push({ name, args });
      return Promise.resolve({});
    });
    await seedFailedAttempt(harness.store, "call-a", "cell-a");
    await seedFailedAttempt(harness.store, "call-b", "cell-b");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
    calls.sort((left, right) => String(left.args.task_id).localeCompare(String(right.args.task_id)));
    expect(calls).toEqual([
      {
        name: "swarm_worktree_cleanup",
        args: { project_path: projectRoot, task_id: "cell-a" },
      },
      {
        name: "swarm_worktree_cleanup",
        args: { project_path: projectRoot, task_id: "cell-b" },
      },
    ]);
  });

  test("deduplicates worktree cleanup by cell ID", async () => {
    const calls: CleanupCall[] = [];
    const { harness } = await startMissionWithProject((name, args) => {
      if (name === "swarm_worktree_cleanup") calls.push({ name, args });
      return Promise.resolve({});
    });
    await seedFailedAttempt(harness.store, "call-a1", "cell-a");
    await seedFailedAttempt(harness.store, "call-a2", "cell-a");
    await seedFailedAttempt(harness.store, "call-b", "cell-b");

    await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(calls).toHaveLength(2);
    expect(calls.map(({ args }) => args.task_id).sort()).toEqual(["cell-a", "cell-b"]);
  });

  test("reports cleanup failures as warnings without failing mission finish", async () => {
    const calls: CleanupCall[] = [];
    const { harness } = await startMissionWithProject((name, args) => {
      if (name === "swarm_worktree_cleanup") {
        calls.push({ name, args });
        if (args.task_id === "cell-a") return Promise.reject(new Error("cleanup failed"));
        if (args.task_id === "cell-b") {
          return Promise.resolve({ success: false, error: "backend reported failure" });
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    await seedFailedAttempt(harness.store, "call-a", "cell-a");
    await seedFailedAttempt(harness.store, "call-b", "cell-b");
    await seedFailedAttempt(harness.store, "call-c", "cell-c");

    const finished = await outputOf(harness.tool("swarm_finish"), { reason: "done" });

    expect(finished.finished).toBe(true);
    expect(calls).toHaveLength(3);
    const warnings = finished.warnings as readonly { readonly taskID: string; readonly message: string }[];
    expect(warnings.map(({ taskID }) => taskID).sort()).toEqual(["cell-a", "cell-b"]);
    expect(warnings.find(({ taskID }) => taskID === "cell-a")).toMatchObject({
      message: "cleanup failed",
    });
    expect(warnings.find(({ taskID }) => taskID === "cell-b")).toMatchObject({
      message: "backend reported failure",
    });
  });
});
