/**
 * Pre-decomposition history lookup (P1.10).
 *
 * Two layers are covered:
 *   - the pure payload → warning/context pipeline (`history.ts`);
 *   - the catalogue wiring: `swarm_decompose` queries `hivemind_find` first,
 *     injects hits into `context`, and warns without blocking on an empty hive.
 */
import { describe, expect, test } from "bun:test";

import { registerTools } from "../src/catalog";
import {
  attachHistorySummary,
  buildDecompositionHistory,
  DECOMPOSITION_HISTORY_LIMIT,
  emptyHistoryWarning,
  HISTORY_CONTEXT_HEADING,
  HISTORY_TOOL_NAME,
  HISTORY_WARNING_PREFIX,
  injectHistoryContext,
  normalizeHistoryHits,
  queryDecompositionHistory,
  renderHistoryContext,
  type DecompositionHistory,
} from "../src/history";
import { createMissionStateStore } from "../src/state";
import type { SwarmxRuntime, ToolContextLike } from "../src/types";
import { createFakeContext, type FakeToolInfo } from "./helpers";

const CALL_CONTEXT = {
  sessionID: "ses_test",
  agent: "swarm/swarm-coordinator",
  messageID: "msg-test",
  id: "call-test",
} as const;

const HITS_PAYLOAD = {
  results: [
    { id: "mem_auth", content: "Refresh tokens need a 5min buffer", score: 0.92, collection: "default" },
    { id: "mem_retry", content: "Retries must be idempotent", score: 0.71, collection: "claude" },
  ],
  count: 2,
};

describe("normalizeHistoryHits", () => {
  test("reads the documented `{ results }` payload", () => {
    const hits = normalizeHistoryHits(HITS_PAYLOAD);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      id: "mem_auth",
      information: "Refresh tokens need a 5min buffer",
      score: 0.92,
      collection: "default",
    });
  });

  test("parses a JSON string payload", () => {
    const hits = normalizeHistoryHits(JSON.stringify(HITS_PAYLOAD));
    expect(hits.map((hit) => hit.id)).toEqual(["mem_auth", "mem_retry"]);
  });

  test("unwraps an MCP text envelope", () => {
    const hits = normalizeHistoryHits({
      content: [{ type: "text", text: JSON.stringify({ results: HITS_PAYLOAD.results }) }],
    });
    expect(hits).toHaveLength(2);
  });

  test("accepts a bare array and memory-shaped items", () => {
    const hits = normalizeHistoryHits([
      { memory: { id: "mem_x", content: "Keep migrations reversible" }, similarity: 0.5 },
    ]);
    expect(hits).toEqual([
      { id: "mem_x", information: "Keep migrations reversible", score: 0.5 },
    ]);
  });

  test("drops unusable entries, deduplicates and truncates long content", () => {
    const long = "x".repeat(600);
    const hits = normalizeHistoryHits([
      { id: "mem_1", content: long },
      { id: "mem_1", content: long },
      { id: "mem_2" },
      null,
      42,
      "plain string memory",
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.information.length).toBeLessThan(long.length);
    expect(hits[0]?.information.endsWith("…")).toBe(true);
    expect(hits[1]).toEqual({ id: "hit-6", information: "plain string memory" });
  });

  test("returns no hits for unknown payload shapes", () => {
    expect(normalizeHistoryHits(undefined)).toEqual([]);
    expect(normalizeHistoryHits({ unexpected: true })).toEqual([]);
    expect(normalizeHistoryHits("not json")).toEqual([]);
  });
});

describe("buildDecompositionHistory", () => {
  test("empty results produce an explicit, non-blocking warning", () => {
    const history = buildDecompositionHistory("Add auth", { results: [], count: 0 });
    expect(history.hits).toEqual([]);
    expect(history.context).toBeUndefined();
    expect(history.warning).toContain(HISTORY_WARNING_PREFIX);
    expect(history.warning).toContain("Add auth");
    expect(history.warning).toContain("non-blocking");
  });

  test("results produce a context block and no warning", () => {
    const history = buildDecompositionHistory("Add auth", HITS_PAYLOAD);
    expect(history.warning).toBeUndefined();
    expect(history.context).toContain(HISTORY_CONTEXT_HEADING);
    expect(history.context).toContain("Refresh tokens need a 5min buffer");
    expect(history.context).toContain("[mem_auth · collection default · score 0.92]");
  });
});

describe("renderHistoryContext", () => {
  test("keeps one bullet per hit and collapses internal newlines", () => {
    const context = renderHistoryContext([
      { id: "mem_1", information: "line one\nline two" },
      { id: "mem_2", information: "second", score: 0.4 },
    ]);
    expect(context.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    expect(context).toContain("line one line two");
    expect(context).toContain("[mem_2 · score 0.40]");
  });
});

describe("injectHistoryContext", () => {
  test("appends the block to an existing context", () => {
    const history: DecompositionHistory = { hits: [], context: "HISTORY BLOCK" };
    expect(injectHistoryContext({ task: "t", context: "existing" }, history)).toEqual({
      task: "t",
      context: "existing\n\nHISTORY BLOCK",
    });
  });

  test("sets context when absent, and leaves args untouched when empty", () => {
    expect(injectHistoryContext({ task: "t" }, { hits: [], context: "H" })).toEqual({
      task: "t",
      context: "H",
    });
    const args = { task: "t" };
    expect(injectHistoryContext(args, { hits: [], warning: "w" })).toBe(args);
  });
});

describe("attachHistorySummary", () => {
  test("adds a history field to a JSON prompt result", () => {
    const summary = attachHistorySummary(JSON.stringify({ prompt: "P" }), {
      hits: [{ id: "a", information: "b" }],
    });
    expect(summary).toEqual({ prompt: "P", history: { queried: true, results_found: 1 } });
  });

  test("carries the warning in the history field", () => {
    const summary = attachHistorySummary({ prompt: "P" }, {
      hits: [],
      warning: emptyHistoryWarning("Add auth"),
    });
    expect(summary).toEqual({
      prompt: "P",
      history: {
        queried: true,
        results_found: 0,
        warning: emptyHistoryWarning("Add auth"),
      },
    });
  });

  test("appends the warning to a plain string result", () => {
    const summary = attachHistorySummary("PLAIN PROMPT", {
      hits: [],
      warning: emptyHistoryWarning("Add auth"),
    });
    expect(summary).toContain("PLAIN PROMPT");
    expect(summary).toContain(HISTORY_WARNING_PREFIX);
  });
});

describe("queryDecompositionHistory", () => {
  test("queries hivemind_find with the task, limit and session scope", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const history = await queryDecompositionHistory(
      {
        runTool: async (name, args) => {
          calls.push({ name, args });
          return HITS_PAYLOAD;
        },
      },
      "Add auth",
      { sessionID: "ses_test" },
    );
    expect(calls).toEqual([
      { name: HISTORY_TOOL_NAME, args: { query: "Add auth", limit: DECOMPOSITION_HISTORY_LIMIT } },
    ]);
    expect(history.hits).toHaveLength(2);
    expect(history.context).toContain(HISTORY_CONTEXT_HEADING);
  });

  test("a failed lookup degrades to a non-blocking warning instead of throwing", async () => {
    const history = await queryDecompositionHistory(
      {
        runTool: () => Promise.reject(new Error("ollama down")),
      },
      "Add auth",
    );
    expect(history.hits).toEqual([]);
    expect(history.warning).toContain("lookup failed: ollama down");
    expect(history.warning).toContain("non-blocking");
  });
});

interface Harness {
  readonly tool: (name: string) => FakeToolInfo;
  readonly calls: { name: string; args: Record<string, unknown> }[];
}

async function setup(answer: (name: string) => Promise<unknown>): Promise<Harness> {
  const ctx = createFakeContext();
  const store = createMissionStateStore(ctx.storage, { projectID: "adeo" });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const runtime: SwarmxRuntime = {
    runTool: async (name, args) => {
      calls.push({ name, args });
      return answer(name);
    },
    listAgents: () => ctx.agent.list(),
    store,
    projectID: "adeo",
    sessionID: "ses_test",
  };

  await registerTools(ctx as unknown as ToolContextLike, runtime);
  const editor = ctx.createEditor();
  ctx.captures.toolTransforms[0]?.(editor);

  return {
    calls,
    tool(name) {
      const found = editor.get(name);
      if (found === undefined) throw new Error(`missing tool ${name}`);
      return found;
    },
  };
}

describe("decomposition history wiring", () => {
  test("hits are injected into the decomposition context", async () => {
    const { tool, calls } = await setup((name) =>
      Promise.resolve(
        name === HISTORY_TOOL_NAME
          ? HITS_PAYLOAD
          : JSON.stringify({ prompt: "DECOMPOSE", expected_schema: "CellTree" }),
      ),
    );

    const result = await tool("swarm_decompose").execute({ task: "Add auth" }, CALL_CONTEXT);

    expect(calls.map((call) => call.name)).toEqual([HISTORY_TOOL_NAME, "swarm_decompose"]);
    const forwarded = calls[1]?.args ?? {};
    expect(forwarded.task).toBe("Add auth");
    expect(forwarded.context).toContain(HISTORY_CONTEXT_HEADING);
    expect(forwarded.context).toContain("Refresh tokens need a 5min buffer");

    const output = result.output as { prompt: string; history: Record<string, unknown> };
    expect(output.prompt).toBe("DECOMPOSE");
    expect(output.history).toEqual({ queried: true, results_found: 2 });
  });

  test("existing context is preserved around the injected block", async () => {
    const { tool, calls } = await setup((name) =>
      Promise.resolve(name === HISTORY_TOOL_NAME ? HITS_PAYLOAD : { prompt: "P" }),
    );
    await tool("swarm_plan_prompt").execute(
      { task: "Add auth", context: "repo: Next.js" },
      CALL_CONTEXT,
    );
    const forwarded = calls[1]?.args ?? {};
    expect(forwarded.context).toStartWith("repo: Next.js");
    expect(forwarded.context).toContain(HISTORY_CONTEXT_HEADING);
  });

  test("zero results warn explicitly and still run the decomposition", async () => {
    const { tool, calls } = await setup((name) =>
      Promise.resolve(name === HISTORY_TOOL_NAME ? { results: [], count: 0 } : { prompt: "P" }),
    );

    const result = await tool("swarm_decompose").execute({ task: "Add auth" }, CALL_CONTEXT);

    expect(calls.map((call) => call.name)).toEqual([HISTORY_TOOL_NAME, "swarm_decompose"]);
    expect(calls[1]?.args.context).toBeUndefined();
    const history = (result.output as { history: { results_found: number; warning: string } })
      .history;
    expect(history.results_found).toBe(0);
    expect(history.warning).toContain(HISTORY_WARNING_PREFIX);
    expect(history.warning).toContain("Add auth");
  });

  test("query_cass: false skips the lookup entirely", async () => {
    const { tool, calls } = await setup((name) =>
      Promise.resolve(name === HISTORY_TOOL_NAME ? HITS_PAYLOAD : { prompt: "P" }),
    );
    await tool("swarm_decompose").execute(
      { task: "Add auth", query_cass: false },
      CALL_CONTEXT,
    );
    expect(calls.map((call) => call.name)).toEqual(["swarm_decompose"]);
  });

  test("a failing lookup never blocks the decomposition", async () => {
    const { tool, calls } = await setup((name) =>
      name === HISTORY_TOOL_NAME
        ? Promise.reject(new Error("index missing"))
        : Promise.resolve({ prompt: "P" }),
    );

    const result = await tool("swarm_decompose").execute({ task: "Add auth" }, CALL_CONTEXT);

    expect(calls[1]?.name).toBe("swarm_decompose");
    const history = (result.output as { history: { warning: string } }).history;
    expect(history.warning).toContain("lookup failed: index missing");
  });
});
