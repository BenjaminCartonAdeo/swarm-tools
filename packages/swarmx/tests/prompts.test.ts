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
  setBudget,
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
    await setBudget(store, { projectID: "adeo", sessionID: "ses_test", mode: "dev", maxSpawns: 20, maxIterations: 3 });

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

  test("resetMission clears the budget document", async () => {
    const PROJECT = "adeo";
    const SESSION = "ses_test";
    const { store } = await setup();
    await store.storage.set(budgetKey(PROJECT, SESSION), { maxSpawns: 5 });
    expect(await store.storage.get(budgetKey(PROJECT, SESSION))).toBeDefined();

    await resetMission(store, { projectID: PROJECT, sessionID: SESSION });
    expect(await store.storage.get(budgetKey(PROJECT, SESSION))).toBeUndefined();
  });

});

describe("consolidation detection", () => {
  const EPIC = "epic-1";
  const SCOPE = { projectID: "adeo", sessionID: "ses_test", epicID: EPIC } as const;

  /** Starts a mission so `maybePrepareConsolidation` has somewhere to persist. */
  async function setupMission() {
    const harness = await setup();
    await setBudget(harness.store, { projectID: "adeo", sessionID: "ses_test", mode: "dev", maxSpawns: 20, maxIterations: 3 });
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
    await setBudget(harness.store, { projectID: "adeo", sessionID: "ses_test", mode: "dev", maxSpawns: 20, maxIterations: 3 });
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
    await setBudget(harness.store, { projectID: "adeo", sessionID: "ses_test", mode: "dev", maxSpawns: 20, maxIterations: 3 });

    const completed = await completeConsolidation(harness.store, {
      projectID: "adeo",
      sessionID: "ses_test",
      cellID: CONSOLIDATION_CELL,
    });

    expect(completed).toBeUndefined();
  });
});

describe("lifecycle tools without a WorkUnit runtime", () => {
  // CLI-only runtimes may omit WorkUnit; lifecycle tools must fail typed and
  // never fall back to raw KV lifecycle keys.
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["swarm_set_budget", {}],
    ["swarm_set_agent", { bead_id: "cell-a", agent: "fast" }],
    ["swarm_resolve_agent", { cells: [{ bead_id: "cell-a", title: "Locate", tier: "fast" }], apply: true }],
    ["swarm_agent_audit", {}],
    ["swarm_mission_status", {}],
    ["swarm_reset", {}],
    ["swarm_finish", {}],
    ["swarm_finish", { abandon: true, all_sessions: true }],
    ["swarm_cancel_completion", { bead_id: "cell-a", reason: "stop" }],
  ];
  for (const [name, args] of cases) {
    test(`${name} ${JSON.stringify(args)} fails runtime_unavailable without touching KV`, async () => {
      const harness = await setup();
      const writes: string[] = [];
      const storage = harness.store.storage;
      const originalSet = storage.set.bind(storage);
      storage.set = (async (key: string, value: unknown) => {
        writes.push(key);
        return originalSet(key, value);
      }) as typeof storage.set;
      const error = await harness.tool(name).execute(args, CALL_CONTEXT).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(String(error)).toContain(`${name} failed [runtime_unavailable]`);
      expect(writes).toEqual([]);
    });
  }
});
