/**
 * Factual compaction contribution + mission audit selectors (Task 6).
 *
 * The compaction builder is a pure function: no CLI, no LLM, no clock, no I/O.
 * These tests pin the contract that matters operationally:
 *   - an active mission yields a non-empty, factual contribution;
 *   - an absent/inactive mission stays a strict no-op (hook pushes nothing);
 *   - the contribution never exceeds `MAX_FACTS_BYTES` (UTF-8), even on a
 *     deliberately oversized mission;
 *   - two calls over the same state produce byte-identical text (stable order);
 *   - no sensitive field ever leaks, and no tool runtime is touched;
 *   - the hook only appends to `event.system` and never defines `event.result`.
 */
import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import { createSwarmxPlugin } from "../src/index";
import {
  COMPACTION_HOOK_NAME,
  MAX_FACTS_BYTES,
  buildCompactionContribution,
} from "../src/compaction";
import {
  createMissionState,
  listAssignments,
  putAttempt,
  selectCells,
  selectMissionSummary,
  selectPendingOrphans,
  selectReadyCells,
  setAssignment,
  setBudget,
  missionKey,
  createMissionStateStore,
  type MissionStateStore,
  type MissionStorageLike,
} from "../src/state";
import type {
  DispatchAttempt,
  MissionCellSnapshot,
  MissionCounts,
  MissionState,
} from "../src/types";
import { createFakeContext, type FakeContext } from "./helpers";

const PROJECT = "adeo";
const SESSION = "ses-compaction";
const NOW = "2026-11-12T09:00:00.000Z";

function counts(overrides: Partial<MissionCounts> = {}): MissionCounts {
  return {
    spawns: 2,
    cells: 2,
    attemptsByCell: { "cell-a": 1, "cell-b": 1 },
    workerSpawns: 1,
    ...overrides,
  };
}

function activeMission(overrides: Partial<MissionState> = {}): MissionState {
  const state = createMissionState({
    projectID: PROJECT,
    sessionID: SESSION,
    mode: "dev",
    budget: { maxSpawns: 6, maxIterations: 3 },
    now: NOW,
  });
  state.counts = counts();
  return { ...state, ...overrides };
}

function attempt(overrides: Partial<DispatchAttempt> = {}): DispatchAttempt {
  return {
    callID: "call-1",
    sessionID: SESSION,
    cellID: "cell-a",
    epicID: "epic-1",
    agent: "swarm-worker",
    status: "succeeded",
    ts: NOW,
    ...overrides,
  };
}

function cells(): readonly MissionCellSnapshot[] {
  return [
    {
      id: "cell-a",
      title: "Implement the bounded compaction builder",
      status: "completed",
      agent: "swarm-worker",
      attempts: 1,
    },
    {
      id: "cell-b",
      title: "Wire the compaction hook",
      status: "pending",
      agent: "ts-pro",
      attempts: 1,
    },
  ];
}

function setup(options: {
  state?: MissionState;
  store?: (ctx: FakeContext) => MissionStateStore;
} = {}): { ctx: FakeContext; store: MissionStateStore } {
  const ctx = createFakeContext({
    projectId: PROJECT,
    ...(options.state === undefined ? {} : { storage: [[missionKey(PROJECT, SESSION), options.state]] }),
  });
  const store =
    options.store?.(ctx) ??
    createMissionStateStore(ctx.storage as unknown as MissionStorageLike, { projectID: PROJECT });
  return { ctx, store };
}

describe("buildCompactionContribution", () => {
  test("active mission yields mode, budget, counters and cells", () => {
    const state = activeMission();
    const contribution = buildCompactionContribution(state, {
      attempts: [attempt()],
      assignments: { "cell-a": "swarm-worker", "cell-b": "ts-pro" },
      cells: cells(),
    });

    expect(contribution).toBeDefined();
    const text = contribution!.text;

    expect(text.startsWith("<swarmx_facts>")).toBe(true);
    expect(text.endsWith("</swarmx_facts>")).toBe(true);
    expect(text).toContain("mode=dev");
    expect(text).toContain("maxSpawns=6");
    expect(text).toContain("maxIterations=3");
    expect(text).toContain("workerShare=0.20");
    expect(text).toContain("spawns=2");
    expect(text).toContain("cells=2");
    expect(text).toContain("workerSpawns=1");
    expect(text).toContain("attemptsByCell=cell-a:1,cell-b:1");
    expect(text).toContain("id=cell-a");
    expect(text).toContain("status=completed");
    expect(text).toContain("status=pending");
    expect(text).toContain("agent=swarm-worker");
    expect(text).toContain("attempts=1");
    expect(text).toContain("Implement the bounded compaction builder");
    // Ready cells exclude the completed one.
    expect(text).toContain("ready=1");
    expect(text).not.toContain("ready=2");
  });

  test("absent or inactive mission is a strict no-op", () => {
    expect(buildCompactionContribution(undefined)).toBeUndefined();
    expect(buildCompactionContribution(activeMission({ active: false }))).toBeUndefined();
  });

  test("contribution stays under the byte ceiling on an oversized mission", () => {
    const huge: MissionState = activeMission({
      counts: counts({ spawns: 200, cells: 200, attemptsByCell: {}, workerSpawns: 20 }),
    });
    const longTitle = "x".repeat(400);
    const manyCells: MissionCellSnapshot[] = Array.from({ length: 200 }, (_, index) => ({
      id: `cell-${String(index).padStart(3, "0")}`,
      title: `${longTitle}-${index}`,
      status: index % 3 === 0 ? "completed" : "pending",
      agent: "swarm-worker",
      attempts: 1,
    }));
    huge.counts.attemptsByCell = Object.fromEntries(manyCells.map((cell) => [cell.id, 1]));

    const contribution = buildCompactionContribution(huge, {
      cells: manyCells,
      // Raised line caps prove the byte ceiling is enforced independently of
      // the default list caps.
      maxCells: 200,
      maxReadyCells: 200,
    });
    expect(contribution).toBeDefined();
    const text = contribution!.text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_FACTS_BYTES);
    expect(text).toContain("truncated=");
    expect(text.startsWith("<swarmx_facts>")).toBe(true);
    expect(text.endsWith("</swarmx_facts>")).toBe(true);

    // Default caps also stay well under the ceiling.
    const defaulted = buildCompactionContribution(huge, { cells: manyCells })!;
    expect(Buffer.byteLength(defaulted.text, "utf8")).toBeLessThanOrEqual(MAX_FACTS_BYTES);
  });

  test("same state produces byte-identical text and a stable order", () => {
    const state = activeMission();
    const first = buildCompactionContribution(state, { cells: cells() })!;
    const second = buildCompactionContribution(state, { cells: cells() })!;
    expect(second.text).toBe(first.text);

    const shuffled = [cells()[1], cells()[0]] as const;
    const reordered = buildCompactionContribution(state, { cells: shuffled })!;
    expect(reordered.text).toBe(first.text);
    // Deterministic (sorted by id) regardless of input order.
    expect(first.text.indexOf("id=cell-a")).toBeLessThan(first.text.indexOf("id=cell-b"));
  });

  test("no sensitive field is emitted and secret-shaped values are redacted", () => {
    const leaky = activeMission() as MissionState & Record<string, unknown>;
    leaky.token = "super-secret-token-value";
    leaky.password = "hunter2-password";
    leaky.sharedContext = "FULL PROMPT THAT MUST NEVER BE COMPACTED";
    leaky.prompt = "FULL PROMPT THAT MUST NEVER BE COMPACTED";

    const contribution = buildCompactionContribution(leaky, {
      attempts: [attempt({ cellID: "cell-a", agent: "swarm-worker" })],
      cells: [
        {
          id: "cell-a",
          title: "rotate token=super-secret-token-value now",
          status: "pending",
          agent: "swarm-worker",
          attempts: 1,
        },
      ],
    });
    expect(contribution).toBeDefined();
    const text = contribution!.text;

    expect(text).not.toContain("super-secret-token-value");
    expect(text).not.toContain("hunter2-password");
    expect(text).not.toContain("FULL PROMPT THAT MUST NEVER BE COMPACTED");
    expect(text).not.toContain("sharedContext");
    expect(text).not.toContain("password");
    expect(text).toContain("token=[redacted]");
  });
});

describe("mission selectors", () => {
  test("selectMissionSummary reports remaining budget", () => {
    const summary = selectMissionSummary(activeMission());
    expect(summary).toBeDefined();
    expect(summary!.mode).toBe("dev");
    expect(summary!.remainingSpawns).toBe(4);
    expect(summary!.remainingIterations).toBe(2);
    expect(summary!.workerShare).toBe(0.2);
    expect(selectMissionSummary(undefined)).toBeUndefined();
  });

  test("selectCells derives id, status, agent and attempts from the ledger", () => {
    const state = activeMission({ counts: counts({ attemptsByCell: { "cell-a": 2 } }) });
    const projected = selectCells({
      state,
      attempts: [
        attempt({ callID: "call-1", status: "failed" }),
        attempt({ callID: "call-2", status: "succeeded" }),
      ],
      assignments: { "cell-a": "ts-pro" },
    });
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe("cell-a");
    expect(projected[0].attempts).toBe(2);
    expect(projected[0].agent).toBe("ts-pro");
    expect(projected[0].status).toBe("completed");
  });

  test("selectReadyCells keeps pending/open cells with satisfied dependencies", () => {
    const ready = selectReadyCells([
      { id: "done", status: "completed", attempts: 1 },
      { id: "next", status: "pending", attempts: 0 },
      { id: "open-cell", status: "open", attempts: 0 },
      { id: "blocked", status: "blocked", attempts: 0 },
      { id: "waiting", status: "pending", attempts: 0, dependsOn: ["next"] },
      { id: "unblocked", status: "pending", attempts: 0, dependsOn: ["done"] },
    ]);
    expect(ready.map((cell) => cell.id)).toEqual(["next", "open-cell", "unblocked"]);
  });

  test("selectPendingOrphans orders pending attempts deterministically", () => {
    const pending = selectPendingOrphans([
      attempt({ callID: "call-b", status: "pending", ts: "2026-11-12T09:00:01.000Z" }),
      attempt({ callID: "call-a", status: "pending", ts: "2026-11-12T09:00:00.000Z" }),
      attempt({ callID: "call-c", status: "succeeded" }),
    ]);
    expect(pending.map((entry) => entry.callID)).toEqual(["call-a", "call-b"]);
  });

  test("listAssignments reads every assignment of the project, sorted", async () => {
    const { store } = setup();
    await setAssignment(store, PROJECT, "cell-b", "ts-pro");
    await setAssignment(store, PROJECT, "cell-a", "swarm-worker");
    await setAssignment(store, "other-project", "cell-x", "nobody");
    expect(await listAssignments(store, PROJECT)).toEqual({
      "cell-a": "swarm-worker",
      "cell-b": "ts-pro",
    });
  });
});

describe("compaction hook wiring", () => {
  test("active mission appends exactly one text part and never defines result", async () => {
    const { ctx } = setup({ state: activeMission() });
    const runtimeCalls: string[] = [];
    const swarmx = createSwarmxPlugin({
      runtime: {
        runTool: async (name) => {
          runtimeCalls.push(name);
          throw new Error(`CLI must never be called during compaction: ${name}`);
        },
      },
    });
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const [hook] = ctx.captures.sessionHooks.get(COMPACTION_HOOK_NAME) ?? [];
    expect(hook).toBeDefined();

    const event = ctx.createCompactionEvent({ sessionID: SESSION });
    const before = event.system.length;
    await hook(event);

    expect(runtimeCalls).toEqual([]);
    expect(event.result).toBeUndefined();
    expect(event.system).toHaveLength(before + 1);
    const appended = event.system.at(-1)!;
    expect(appended.type).toBe("text");
    expect(appended.text).toContain("<swarmx_facts>");
    expect(appended.text).toContain("mode=dev");
  });

  test("inactive mission pushes nothing", async () => {
    const { ctx } = setup({ state: activeMission({ active: false }) });
    const swarmx = createSwarmxPlugin();
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const [hook] = ctx.captures.sessionHooks.get(COMPACTION_HOOK_NAME) ?? [];
    const event = ctx.createCompactionEvent({ sessionID: SESSION });
    const before = event.system.length;
    await hook(event);

    expect(event.system).toHaveLength(before);
    expect(event.result).toBeUndefined();
  });

  test("no mission document pushes nothing", async () => {
    const { ctx } = setup();
    const swarmx = createSwarmxPlugin();
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const [hook] = ctx.captures.sessionHooks.get(COMPACTION_HOOK_NAME) ?? [];
    const event = ctx.createCompactionEvent({ sessionID: SESSION });
    const before = event.system.length;
    await hook(event);

    expect(event.system).toHaveLength(before);
  });

  test("storage failure never escapes the hook", async () => {
    const { ctx } = setup();
    const swarmx = createSwarmxPlugin();
    await swarmx.setup(ctx as unknown as Plugin.Context);
    ctx.storage.get = async () => {
      throw new Error("storage offline");
    };

    const [hook] = ctx.captures.sessionHooks.get(COMPACTION_HOOK_NAME) ?? [];
    const event = ctx.createCompactionEvent({ sessionID: SESSION });
    const before = event.system.length;

    await expect(hook(event)).resolves.toBeUndefined();
    expect(event.system).toHaveLength(before);
    expect(event.result).toBeUndefined();
  });

  test("the hook reflects ledger cells recorded through the mission store", async () => {
    const { ctx, store } = setup();
    const mission = await setBudget(store, {
      projectID: PROJECT,
      sessionID: SESSION,
      mode: "audit",
      maxSpawns: 4,
      maxIterations: 2,
    });
    await setAssignment(store, PROJECT, "cell-z", "tr-pro");
    await putAttempt(
      store,
      PROJECT,
      attempt({
        callID: "call-z",
        cellID: "cell-z",
        missionID: mission.missionID,
        status: "pending",
      }),
    );

    const swarmx = createSwarmxPlugin();
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const [hook] = ctx.captures.sessionHooks.get(COMPACTION_HOOK_NAME) ?? [];
    const event = ctx.createCompactionEvent({ sessionID: SESSION });
    await hook(event);

    const appended = event.system.at(-1)!;
    expect(appended.text).toContain("mode=audit");
    expect(appended.text).toContain("id=cell-z");
    expect(appended.text).toContain("agent=tr-pro");
    expect(appended.text).toContain("pendingOrphans=1");
  });
});
