/**
 * Mission state + dispatch gate invariants (Task 4).
 *
 * Covers, end to end, on the fake V2 context (`tests/helpers.ts`):
 *   - no mission ⇒ no gate, no counter, no write;
 *   - budget fixed once per session, global / per-cell / worker-share ceilings;
 *   - strict cell-marker parsing, roster gating, assignment mismatch;
 *   - exact-once ledger keyed by `Tool.CallID`, orphan recovery;
 *   - persistence, `finishMission`, `audit`.
 */
import { describe, expect, test } from "bun:test";
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
  audit,
  createMissionStateStore,
  finishMission,
  listAttempts,
  putAttempt,
  readMission,
  resolveAssignment,
  setAssignment,
  setBudget,
  withMissionLock,
  type MissionStateStore,
  type MissionStorageLike,
} from "../src/state";
import { DispatchGateError, type GateReason, type MissionState } from "../src/types";
import { createFakeContext, type FakeAgentInfo, type FakeContext } from "./helpers";

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
  readonly store: MissionStateStore;
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

interface BudgetOverrides {
  readonly sessionID?: string;
  readonly mode?: "audit" | "dev";
  readonly maxSpawns?: number;
  readonly maxIterations?: number;
  readonly workerShare?: number;
}

async function startMission(
  store: MissionStateStore,
  overrides: BudgetOverrides = {},
): Promise<MissionState> {
  return setBudget(store, {
    projectID: PROJECT,
    sessionID: overrides.sessionID ?? SESSION,
    mode: overrides.mode ?? "dev",
    maxSpawns: overrides.maxSpawns ?? 5,
    maxIterations: overrides.maxIterations ?? 3,
    ...(overrides.workerShare === undefined ? {} : { workerShare: overrides.workerShare }),
  });
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

describe("mission budget lifecycle", () => {
  test("setBudget creates one scoped mission with a normalized budget", async () => {
    const { ctx, store } = setup();

    const state = await startMission(store, { maxSpawns: 3, maxIterations: 2 });

    expect(state.active).toBe(true);
    expect(state.mode).toBe("dev");
    expect(state.budget).toEqual({ maxSpawns: 3, maxIterations: 2, workerShare: 0.2 });
    expect(state.counts).toEqual({ spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 });
    expect(state.projectID).toBe(PROJECT);
    expect(state.sessionID).toBe(SESSION);

    // Storage key is namespaced per project + session.
    expect(ctx.storage.map.has(`mission:${PROJECT}:${SESSION}`)).toBe(true);
    // Another session is untouched.
    expect(await store.load(PROJECT, "ses-other")).toBeUndefined();
  });

  test("setBudget is fixed once per active mission and scoped per session", async () => {
    const { store } = setup();
    await startMission(store);

    await expect(
      startMission(store, { maxSpawns: 99, maxIterations: 99 }),
    ).rejects.toThrow(/budget already set/);

    // A different session starts its own mission.
    await expect(startMission(store, { sessionID: "ses-2" })).resolves.toBeDefined();
  });

  test("finishMission deactivates the mission and allows a fresh budget", async () => {
    const { store } = setup();
    await startMission(store, { maxSpawns: 1 });

    const finished = await finishMission(store, { projectID: PROJECT, sessionID: SESSION });
    expect(finished?.active).toBe(false);
    expect((await store.load(PROJECT, SESSION))?.active).toBe(false);

    const restarted = await startMission(store, { maxSpawns: 4 });
    expect(restarted.counts.spawns).toBe(0);
    expect((await store.load(PROJECT, SESSION))?.budget.maxSpawns).toBe(4);
  });

  test("finishMission refuses to deactivate while a dispatch attempt is unrevoked", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await allow(gateBefore(store, beforeEvent({ id: "call-pending-finish" })));

    await expect(finishMission(store, { projectID: PROJECT, sessionID: SESSION })).rejects.toThrow(
      /mission has unrevoked worker attempts/,
    );
    expect((await readMission(store, PROJECT, SESSION))?.active).toBe(true);
  });

  test("a restarted same-session mission excludes prior-generation attempts", async () => {
    const { store } = setup();
    const firstMission = await startMission(store, { maxSpawns: 1 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await gateBefore(store, beforeEvent({ id: "call-old", cell: "cell-a" }));
    await settleAfter(store, afterEvent("error", { id: "call-old", cell: "cell-a" }));
    await finishMission(store, { projectID: PROJECT, sessionID: SESSION });

    const restartedMission = await startMission(store, { maxSpawns: 1 });
    expect(restartedMission.missionID).not.toBe(firstMission.missionID);
    await setAssignment(store, PROJECT, "cell-b", "ts-pro");
    await refuse(
      gateBefore(store, beforeEvent({ id: "call-old", cell: "cell-b" })),
      "call_id_conflict",
    );
    await allow(gateBefore(store, beforeEvent({ id: "call-new", cell: "cell-b" })));

    const summary = await audit(store, PROJECT, SESSION);
    expect(summary.counts?.spawns).toBe(1);
    expect(summary.attempts.map((attempt) => attempt.callID)).toEqual(["call-new"]);
  });

  test("a legacy mission without a generation ID ignores attempts before its start", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
      projectID: PROJECT,
      listAgents: () => ctx.agent.list(),
      now: () => "2026-02-01T00:00:00.000Z",
    });
    const mission = await startMission(store);
    delete mission.missionID;
    await store.save(mission);
    await putAttempt(store, PROJECT, {
      callID: "call-previous-legacy-generation",
      sessionID: SESSION,
      cellID: "cell-old",
      epicID: "epic-old",
      agent: "development/typescript-pro",
      status: "succeeded",
      ts: "2026-01-31T23:59:59.000Z",
    });
    await putAttempt(store, PROJECT, {
      callID: "call-current-legacy-generation",
      sessionID: SESSION,
      cellID: "cell-current",
      epicID: "epic-current",
      agent: "development/typescript-pro",
      status: "succeeded",
      ts: "2026-02-01T00:00:01.000Z",
    });

    const summary = await audit(store, PROJECT, SESSION);

    expect(summary.counts?.spawns).toBe(1);
    expect(summary.attempts.map((attempt) => attempt.callID)).toEqual([
      "call-current-legacy-generation",
    ]);
  });
});

describe("outside the mission", () => {
  test("gateBefore/settleAfter are silent no-ops without an active mission", async () => {
    const { ctx, store } = setup();
    const size = ctx.storage.map.size;

    await allow(gateBefore(store, beforeEvent()));
    await allow(settleAfter(store, afterEvent("completed")));

    expect(ctx.storage.map.size).toBe(size);
    expect(await store.load(PROJECT, SESSION)).toBeUndefined();
  });

  test("gateBefore ignores any tool other than subagent", async () => {
    const { ctx, store } = setup();
    await startMission(store);
    const size = ctx.storage.map.size;

    await allow(gateBefore(store, beforeEvent({ tool: "bash" })));
    await allow(settleAfter(store, afterEvent("completed", { tool: "bash" })));

    expect(ctx.storage.map.size).toBe(size);
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("gateBefore is a no-op once the mission is finished", async () => {
    const { ctx, store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await finishMission(store, { projectID: PROJECT, sessionID: SESSION });
    const size = ctx.storage.map.size;

    await allow(gateBefore(store, beforeEvent()));

    expect(ctx.storage.map.size).toBe(size);
  });
});

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

  test("gateBefore reports the marker reasons without recording a spawn", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    const missing = await refuse(
      gateBefore(store, beforeEvent({ prompt: "no marker here" })),
      "cell_marker_missing",
    );
    expect(missing.message).toContain("cell_marker_missing");

    await refuse(
      gateBefore(store, beforeEvent({ prompt: "<!-- swarmx:cell=cell-a -->" })),
      "cell_marker_malformed",
    );

    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });
});

describe("agent and assignment gates", () => {
  test("only the canonical coordinator may dispatch assigned cells", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    for (const callerAgent of ["swarm/swarm-worker", "development/mode-all", "build"]) {
      await refuse(
        gateBefore(store, beforeEvent({ id: `caller-${callerAgent}`, callerAgent })),
        "caller_not_coordinator",
      );
    }

    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("refuses dispatch while a cleanup claim is active for the cell", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await store.storage.set(`cleanup-claim:${PROJECT}`, { taskID: "cell-a", at: Date.now() });

    await refuse(gateBefore(store, beforeEvent()), "cleanup_in_progress");
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("allows dispatch after a stale cleanup claim expires", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await store.storage.set(`cleanup-claim:${PROJECT}`, { taskID: "*", at: Date.now() - 6 * 60_000 });

    await allow(gateBefore(store, beforeEvent()));
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(1);
  });

  test("rejects re-entrant mission lock acquisition", async () => {
    await expect(
      withMissionLock(PROJECT, SESSION, () =>
        withMissionLock(PROJECT, SESSION, async () => "nested"),
      ),
    ).rejects.toThrow(/reentrant mission lock/);
  });

  test("uses the subagent input target instead of the execute hook caller", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await allow(gateBefore(store, beforeEvent()));

    const { attempts, counts } = await audit(store, PROJECT, SESSION);
    expect(attempts[0]?.agent).toBe("development/typescript-pro");
    expect(counts?.spawns).toBe(1);
  });

  test("injects a one-use dispatch capability into the reserved worker prompt", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    const event = beforeEvent({ id: "call-capability-first" });

    await allow(gateBefore(store, event));

    const prompt = (event.input as { prompt: string }).prompt;
    const marker = extractCellMarker({ prompt });
    expect(marker.dispatchToken).toMatch(/^[a-f0-9-]{36}$/);
    const attempt = (await listAttempts(store, PROJECT, SESSION))[0];
    expect(attempt?.dispatchToken).toBe(marker.dispatchToken);

    await refuse(
      gateBefore(
        store,
        beforeEvent({ id: "call-capability-reuse", prompt, targetAgent: "development/typescript-pro" }),
      ),
      "dispatch_token_reused",
    );
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(1);
  });

  test("refuses a V2 subagent input that omits its target agent", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await refuse(
      gateBefore(
        store,
        beforeEvent({ input: { prompt: `Implement the subtask.\n\n${cellMarker("cell-a")}` } }),
      ),
      "agent_missing",
    );

    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("refuses an unknown agent and never falls back to swarm-worker", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ghost-agent");

    const error = await refuse(
      gateBefore(store, beforeEvent({ targetAgent: "ghost-agent" })),
      "agent_unknown",
    );
    expect(error.detail).toContain("no fallback agent");
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("requires the exact V2 target agent ID instead of a display-name alias", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    for (const targetAgent of ["ts-pro", " development/typescript-pro "]) {
      await refuse(
        gateBefore(store, beforeEvent({ targetAgent })),
        "agent_unknown",
      );
    }

    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("refuses a dispatch if the mission is finished while target validation is pending", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    let announceRosterRead!: () => void;
    let releaseRoster!: (agents: readonly FakeAgentInfo[]) => void;
    const rosterReadStarted = new Promise<void>((resolve) => {
      announceRosterRead = resolve;
    });
    const pendingRoster = new Promise<readonly FakeAgentInfo[]>((resolve) => {
      releaseRoster = resolve;
    });
    const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
      projectID: PROJECT,
      listAgents: () => {
        announceRosterRead();
        return pendingRoster;
      },
    });
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    const pendingDispatch = gateBefore(store, beforeEvent());
    await rosterReadStarted;
    await finishMission(store, { projectID: PROJECT, sessionID: SESSION });
    releaseRoster(AGENTS);

    await refuse(pendingDispatch, "mission_inactive");
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("refuses a dispatch if its mission is replaced during target validation", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    let announceRosterRead!: () => void;
    let releaseRoster!: (agents: readonly FakeAgentInfo[]) => void;
    const rosterReadStarted = new Promise<void>((resolve) => {
      announceRosterRead = resolve;
    });
    const pendingRoster = new Promise<readonly FakeAgentInfo[]>((resolve) => {
      releaseRoster = resolve;
    });
    const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
      projectID: PROJECT,
      listAgents: () => {
        announceRosterRead();
        return pendingRoster;
      },
    });
    await startMission(store, { maxSpawns: 1 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    const pendingDispatch = gateBefore(store, beforeEvent());
    await rosterReadStarted;
    await finishMission(store, { projectID: PROJECT, sessionID: SESSION });
    await startMission(store, { maxSpawns: 1 });
    releaseRoster(AGENTS);

    const result = await pendingDispatch.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(DispatchGateError);
    expect((result as DispatchGateError).reason).toBe("mission_changed");
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("refuses hidden and primary agents", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "internal-helper");
    await setAssignment(store, PROJECT, "cell-b", "build");

    await refuse(
      gateBefore(store, beforeEvent({ targetAgent: "internal-helper" })),
      "agent_not_dispatchable",
    );
    await refuse(
      gateBefore(store, beforeEvent({ targetAgent: "build", cell: "cell-b" })),
      "agent_not_dispatchable",
    );
  });

  test("refuses an unassigned cell and an assignment mismatch", async () => {
    const { store } = setup();
    await startMission(store);

    const unassigned = await refuse(
      gateBefore(store, beforeEvent({ cell: "cell-a" })),
      "cell_not_assigned",
    );
    expect(unassigned.cellID).toBe("cell-a");

    await setAssignment(store, PROJECT, "cell-a", "swarm-worker");
    const mismatch = await refuse(
      gateBefore(store, beforeEvent({ cell: "cell-a", targetAgent: "development/typescript-pro" })),
      "assignment_mismatch",
    );
    expect(mismatch.cellID).toBe("cell-a");
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("resolveAssignment reads the [agent: x] tag without writing", async () => {
    const { ctx, store } = setup();
    const size = ctx.storage.map.size;

    expect(await resolveAssignment(store, PROJECT, "cell-a", "desc [agent: ts-pro]")).toBe(
      "ts-pro",
    );
    expect(ctx.storage.map.size).toBe(size);

    await setAssignment(store, PROJECT, "cell-a", "swarm-worker");
    // Storage wins over the tag.
    expect(await resolveAssignment(store, PROJECT, "cell-a", "[agent: ts-pro]")).toBe(
      "swarm-worker",
    );
  });
});

describe("budget gates", () => {
  test("enforces the global spawn ceiling", async () => {
    const { store } = setup();
    await startMission(store, { maxSpawns: 1, maxIterations: 5 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await setAssignment(store, PROJECT, "cell-b", "ts-pro");

    await allow(gateBefore(store, beforeEvent({ id: "call-1", cell: "cell-a" })));
    const error = await refuse(
      gateBefore(store, beforeEvent({ id: "call-2", cell: "cell-b" })),
      "budget_exhausted",
    );
    expect(error.detail).toContain("1/1");
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(1);
  });

  test("enforces the per-cell iteration ceiling", async () => {
    const { store } = setup();
    await startMission(store, { maxSpawns: 5, maxIterations: 1 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await setAssignment(store, PROJECT, "cell-b", "ts-pro");

    await allow(gateBefore(store, beforeEvent({ id: "call-1", cell: "cell-a" })));
    await refuse(
      gateBefore(store, beforeEvent({ id: "call-2", cell: "cell-a" })),
      "cell_iterations_exhausted",
    );
    // Another cell still has its own allowance.
    await allow(gateBefore(store, beforeEvent({ id: "call-3", cell: "cell-b" })));
  });

  test("enforces the swarm-worker share ceiling", async () => {
    const { store } = setup();
    await startMission(store, { maxSpawns: 10, maxIterations: 10, workerShare: 0.5 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await setAssignment(store, PROJECT, "cell-b", "swarm/swarm-worker");
    await setAssignment(store, PROJECT, "cell-c", "swarm/swarm-worker");

    // 1 non-worker: worker share would be 1/2 = 0.5 → allowed.
    await allow(gateBefore(store, beforeEvent({ id: "call-1", cell: "cell-a" })));
    await allow(
      gateBefore(store, beforeEvent({ id: "call-2", cell: "cell-b", targetAgent: "swarm/swarm-worker" })),
    );
    // 2 workers out of 3 spawns = 0.67 > 0.5 → refused.
    const error = await refuse(
      gateBefore(store, beforeEvent({ id: "call-3", cell: "cell-c", targetAgent: "swarm/swarm-worker" })),
      "worker_share_exceeded",
    );
    expect(error.detail).toContain("0.67");

    const counts = (await store.load(PROJECT, SESSION))?.counts;
    expect(counts?.spawns).toBe(2);
    expect(counts?.workerSpawns).toBe(1);
  });

  test("counts a legacy bare worker ID when it is the roster's exact V2 ID", async () => {
    const legacyAgents = AGENTS.map((agent) =>
      agent.id === "swarm/swarm-worker" ? { ...agent, id: "swarm-worker" } : agent,
    );
    const ctx = createFakeContext({ agents: legacyAgents, projectId: PROJECT });
    const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
      projectID: PROJECT,
      listAgents: () => ctx.agent.list(),
    });
    await startMission(store, { workerShare: 1 });
    await setAssignment(store, PROJECT, "cell-a", "swarm-worker");

    await allow(gateBefore(store, beforeEvent({ targetAgent: "swarm-worker" })));

    expect((await store.load(PROJECT, SESSION))?.counts.workerSpawns).toBe(1);
  });

  test("serializes concurrent reservations (no lost update)", async () => {
    const { store } = setup();
    await startMission(store, { maxSpawns: 2, maxIterations: 10 });
    for (const cell of ["cell-a", "cell-b", "cell-c", "cell-d", "cell-e"]) {
      await setAssignment(store, PROJECT, cell, "ts-pro");
    }

    const results = await Promise.allSettled(
      ["cell-a", "cell-b", "cell-c", "cell-d", "cell-e"].map((cell, index) =>
        gateBefore(store, beforeEvent({ id: `call-${index}`, cell })),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    for (const rejection of refused) {
      expect((rejection.reason as DispatchGateError).reason).toBe("budget_exhausted");
    }
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(2);
  });
});

describe("ledger idempotency", () => {
  test("reconciles a ledger-first reservation after the mission save fails", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    let failNextMissionSave = false;
    const storage: MissionStorageLike = {
      async get(key) {
        const value = await ctx.storage.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      async set(key, value) {
        if (failNextMissionSave && key.startsWith("mission:")) {
          failNextMissionSave = false;
          throw new Error("injected mission save failure");
        }
        await ctx.storage.set(key, structuredClone(value));
      },
      remove: (key) => ctx.storage.remove(key),
      async scan(options) {
        const result = await ctx.storage.scan(options);
        return {
          ...result,
          entries: result.entries.map((entry) => ({
            key: entry.key,
            value: structuredClone(entry.value),
          })),
        };
      },
    };
    const store = createMissionStateStore(storage, {
      projectID: PROJECT,
      listAgents: () => ctx.agent.list(),
    });
    await startMission(store, { maxSpawns: 1 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await setAssignment(store, PROJECT, "cell-b", "ts-pro");
    failNextMissionSave = true;

    await expect(gateBefore(store, beforeEvent({ id: "call-partial" }))).rejects.toThrow(
      "injected mission save failure",
    );
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(0);
    expect((await listAttempts(store, PROJECT, SESSION))[0]?.status).toBe("pending");

    // Replaying the same call ID must reconcile the ledger before allowing it.
    await allow(gateBefore(store, beforeEvent({ id: "call-partial" })));
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(1);

    // The recovered reservation still consumes the only spawn; it cannot be bypassed with a new call ID.
    await refuse(
      gateBefore(store, beforeEvent({ id: "call-next", cell: "cell-b" })),
      "budget_exhausted",
    );
    const summary = await audit(store, PROJECT, SESSION);
    expect(summary.counts?.spawns).toBe(1);
    expect(summary.pendingOrphans).toBe(1);
  });

  test("before + after charges and settles exactly one spawn", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await gateBefore(store, beforeEvent({ id: "call-1" }));
    await settleAfter(store, afterEvent("completed", { id: "call-1" }));

    const mission = await store.load(PROJECT, SESSION);
    expect(mission?.counts.spawns).toBe(1);
    expect(mission?.counts.cells).toBe(1);
    expect(mission?.counts.attemptsByCell).toEqual({ "cell-a": 1 });

    const { attempts } = await audit(store, PROJECT, SESSION);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("succeeded");
  });

  test("a replayed callID never increments a counter", async () => {
    const { store } = setup();
    await startMission(store, { maxSpawns: 1 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await gateBefore(store, beforeEvent({ id: "call-1" }));
    // Replay of the same call: passes even though the budget is now exhausted.
    await allow(gateBefore(store, beforeEvent({ id: "call-1" })));

    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(1);
  });

  test("refuses replay after a callID has already settled", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await gateBefore(store, beforeEvent({ id: "call-settled" }));
    await settleAfter(store, afterEvent("completed", { id: "call-settled" }));

    await refuse(gateBefore(store, beforeEvent({ id: "call-settled" })), "call_id_conflict");
    expect((await store.load(PROJECT, SESSION))?.counts.spawns).toBe(1);
  });

  test("refuses a replayed callID when its cell or target agent changes", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await setAssignment(store, PROJECT, "cell-b", "swarm/swarm-worker");
    await gateBefore(store, beforeEvent({ id: "call-replay", cell: "cell-a" }));

    await refuse(
      gateBefore(
        store,
        beforeEvent({ id: "call-replay", cell: "cell-b", targetAgent: "swarm/swarm-worker" }),
      ),
      "call_id_conflict",
    );

    const mission = await store.load(PROJECT, SESSION);
    expect(mission?.counts.spawns).toBe(1);
    expect(mission?.counts.attemptsByCell).toEqual({ "cell-a": 1 });
  });

  test("refuses replay when a legacy ledger entry lacks the current epic ID", async () => {
    const { store } = setup();
    const mission = await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await putAttempt(store, PROJECT, {
      callID: "call-without-epic",
      missionID: mission.missionID,
      sessionID: SESSION,
      cellID: "cell-a",
      agent: "development/typescript-pro",
      status: "pending",
      ts: "2026-01-01T00:00:00.000Z",
    });

    await refuse(
      gateBefore(store, beforeEvent({ id: "call-without-epic", cell: "cell-a", epic: "new-epic" })),
      "call_id_conflict",
    );
  });

  test("a duplicate settleAfter gains nothing", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await gateBefore(store, beforeEvent({ id: "call-1" }));
    await settleAfter(store, afterEvent("completed", { id: "call-1" }));
    await settleAfter(store, afterEvent("completed", { id: "call-1" }));
    await settleAfter(store, afterEvent("error", { id: "call-1" }));
    // Unknown call id: silently ignored, never throws.
    await allow(settleAfter(store, afterEvent("error", { id: "call-unknown" })));

    const mission = await store.load(PROJECT, SESSION);
    expect(mission?.counts.spawns).toBe(1);
    const { attempts } = await audit(store, PROJECT, SESSION);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("succeeded");
  });

  test("an execute.before without execute.after is recovered as aborted, no double gain", async () => {
    const { store } = setup();
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await gateBefore(store, beforeEvent({ id: "call-crashed" }));
    // Raw ledger read (no recovery): the reservation is still pending.
    const pending = await listAttempts(store, PROJECT, SESSION);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");

    const summary = await audit(store, PROJECT, SESSION);
    expect(summary.pendingOrphans).toBe(1);
    expect(summary.attempts[0]?.status).toBe("aborted");
    expect(summary.counts?.spawns).toBe(1);

    // Second audit: nothing left to recover, counters still unchanged.
    const next = await audit(store, PROJECT, SESSION);
    expect(next.pendingOrphans).toBe(0);
    expect(next.counts?.spawns).toBe(1);
  });

  test("settleAfter never rejects, even with a broken payload", async () => {
    const { store } = setup();
    await startMission(store);

    await allow(settleAfter(store, afterEvent("error", { id: "missing" })));
    await allow(
      settleAfter(store, {
        ...beforeEvent(),
        status: "completed",
        result: undefined,
      }),
    );
  });
});

describe("persistence and audit", () => {
  test("audit reconciles an orphan ledger entry when the mission counters were not saved", async () => {
    const { store } = setup();
    const mission = await startMission(store, { maxSpawns: 1 });
    await putAttempt(store, PROJECT, {
      callID: "call-partial-write",
      missionID: mission.missionID,
      sessionID: SESSION,
      cellID: "cell-a",
      epicID: "cell-epic",
      agent: "development/typescript-pro",
      status: "pending",
      ts: "2026-01-01T00:00:00.000Z",
    });

    const summary = await audit(store, PROJECT, SESSION);

    expect(summary.pendingOrphans).toBe(1);
    expect(summary.attempts[0]?.status).toBe("aborted");
    expect(summary.counts?.spawns).toBe(1);
    expect(summary.counts?.attemptsByCell).toEqual({ "cell-a": 1 });
  });

  test("state survives a store reload over the same storage", async () => {
    const { ctx, store } = setup();
    await startMission(store, { maxSpawns: 4, maxIterations: 2 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await gateBefore(store, beforeEvent({ id: "call-1" }));

    const reloaded = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
      projectID: PROJECT,
      listAgents: () => ctx.agent.list(),
    });

    const mission = await reloaded.load(PROJECT, SESSION);
    expect(mission?.counts.spawns).toBe(1);
    expect(mission?.budget.maxSpawns).toBe(4);
    expect(await resolveAssignment(reloaded, PROJECT, "cell-a")).toBe("ts-pro");
    expect((await audit(reloaded, PROJECT, SESSION)).attempts).toHaveLength(1);
    expect((await store.list()).map((entry) => entry.sessionID)).toEqual([SESSION]);
  });

  test("audit reflects the mission state", async () => {
    const { store } = setup();
    await startMission(store, { mode: "audit", maxSpawns: 3, maxIterations: 2 });
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await gateBefore(store, beforeEvent({ id: "call-1" }));
    await settleAfter(store, afterEvent("completed", { id: "call-1" }));

    const summary = await audit(store, PROJECT, SESSION);
    expect(summary.active).toBe(true);
    expect(summary.mode).toBe("audit");
    expect(summary.budget).toEqual({ maxSpawns: 3, maxIterations: 2, workerShare: 0.2 });
    expect(summary.counts).toEqual({
      spawns: 1,
      cells: 1,
      attemptsByCell: { "cell-a": 1 },
      workerSpawns: 0,
    });
    expect(summary.attempts).toHaveLength(1);
    expect(summary.attempts[0]).toMatchObject({
      callID: "call-1",
      sessionID: SESSION,
      cellID: "cell-a",
      epicID: "cell-epic",
      agent: "development/typescript-pro",
      status: "succeeded",
    });
    expect(summary.pendingOrphans).toBe(0);
  });
});

describe("plugin wiring", () => {
  test("setup wires execute.before/after to the mission store", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    await swarmx.setup(ctx as unknown as Plugin.Context);

    const beforeHooks = ctx.captures.toolHooks.get("execute.before") ?? [];
    const afterHooks = ctx.captures.toolHooks.get("execute.after") ?? [];
    expect(beforeHooks).toHaveLength(1);
    expect(afterHooks).toHaveLength(1);

    // Same storage the plugin holds: a gate refusal must be visible end to end.
    const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike);
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");

    await allow(Promise.resolve(beforeHooks[0]?.(beforeEvent())));
    await allow(Promise.resolve(afterHooks[0]?.(afterEvent("completed"))));

    const summary = await audit(store, PROJECT, SESSION);
    expect(summary.counts?.spawns).toBe(1);
    expect(summary.attempts[0]?.status).toBe("succeeded");

    await expect(
      Promise.resolve(beforeHooks[0]?.(beforeEvent({ id: "call-2", prompt: "no marker" }))),
    ).rejects.toBeInstanceOf(DispatchGateError);
  });
});
