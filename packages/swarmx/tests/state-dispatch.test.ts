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
import { afterEach, describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import swarmx, { createSwarmxPlugin } from "../src/index";

/** Legacy-branch plugin: explicitly opts out of the default WorkUnit lifecycle. */
const legacySwarmx = createSwarmxPlugin({ runtime: { workUnit: undefined } });
import {
  DISPATCH_TOOL_NAME,
  extractCellMarker,
  gateBefore,
  settleAfter,
  type DispatchAfterEvent,
  type DispatchBeforeEvent,
} from "../src/dispatch";
import {
  assignmentKey,
  acquireBuildLock,
  audit,
  createMissionStateStore,
  finishMission,
  listAttempts,
  putAttempt,
  readMission,
  releaseBuildLock,
  resolveAssignment,
  resetMission,
  setAssignment,
  setBudget,
  withMissionLock,
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

interface BudgetOverrides {
  readonly sessionID?: string;
  readonly mode?: "audit" | "dev";
  readonly maxSpawns?: number;
  readonly maxIterations?: number;
  readonly workerShare?: number;
}

async function startMission(
  store: LegacyMissionStateStore,
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

    for (const callerAgent of ["swarm/swarm-worker", "development/mode-all"]) {
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

  test("an execute.before without execute.after remains a pending orphan candidate", async () => {
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
    expect(summary.attempts[0]?.status).toBe("pending");
    expect(summary.counts?.spawns).toBe(1);

    // Second audit: the pending attempt remains a candidate, counters unchanged.
    const next = await audit(store, PROJECT, SESSION);
    expect(next.pendingOrphans).toBe(1);
    expect(next.counts?.spawns).toBe(1);
  });

  test("timerExpiryDoesNotAbortLiveWorkerAttempt", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    let now = "2026-01-01T00:00:00.000Z";
    const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
      projectID: PROJECT,
      listAgents: () => ctx.agent.list(),
      now: () => now,
      orphanGraceMs: 1_000,
    });
    await startMission(store);
    await setAssignment(store, PROJECT, "cell-a", "ts-pro");
    await gateBefore(store, beforeEvent({ id: "call-live-worker" }));
    const countsBeforeAudit = (await readMission(store, PROJECT, SESSION))?.counts;
    now = "2026-01-01T00:00:02.000Z";

    const summary = await audit(store, PROJECT, SESSION);

    expect(summary.pendingOrphans).toBe(1);
    expect(summary.attempts[0]?.status).toBe("pending");
    expect(summary.counts).toEqual(countsBeforeAudit);
    expect((await listAttempts(store, PROJECT, SESSION))[0]?.status).toBe("pending");
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
    expect(summary.attempts[0]?.status).toBe("pending");
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

describe("session-scoped reset and assignment ownership", () => {
  test("reset removes only this session's attempts and assignments", async () => {
    const { store } = setup();
    const current = await startMission(store, { sessionID: SESSION });
    const otherSession = "ses-other";
    const other = await startMission(store, { sessionID: otherSession });
    const ts = "2026-11-17T00:00:00.000Z";

    await putAttempt(store, PROJECT, {
      callID: "call-current-session",
      missionID: current.missionID,
      sessionID: SESSION,
      cellID: "cell-current-session",
      agent: "development/typescript-pro",
      status: "failed",
      ts,
    });
    await putAttempt(store, PROJECT, {
      callID: "call-other-session",
      missionID: other.missionID,
      sessionID: otherSession,
      cellID: "cell-other-session",
      agent: "vue",
      status: "failed",
      ts,
    });
    await store.storage.set(assignmentKey(PROJECT, "cell-current-session"), {
      cellID: "cell-current-session",
      agent: "development/typescript-pro",
      sessionID: SESSION,
    });
    await store.storage.set(assignmentKey(PROJECT, "cell-other-session"), {
      cellID: "cell-other-session",
      agent: "vue",
      sessionID: otherSession,
    });

    await resetMission(store, { projectID: PROJECT, sessionID: SESSION });

    expect(await store.load(PROJECT, SESSION)).toBeUndefined();
    expect(await store.load(PROJECT, otherSession)).toMatchObject({ active: true });
    expect(await listAttempts(store, PROJECT, SESSION)).toEqual([]);
    expect(await listAttempts(store, PROJECT, otherSession)).toHaveLength(1);
    expect(await resolveAssignment(store, PROJECT, "cell-current-session")).toBeUndefined();
    expect(await resolveAssignment(store, PROJECT, "cell-other-session")).toBe("vue");
  });

  test("an assignment owned by another session cannot satisfy the dispatch gate", async () => {
    const { store } = setup();
    await startMission(store, { sessionID: SESSION });
    await startMission(store, { sessionID: "ses-other" });
    await store.storage.set(assignmentKey(PROJECT, "cell-a"), {
      cellID: "cell-a",
      agent: "development/typescript-pro",
      sessionID: "ses-other",
    });

    await refuse(
      gateBefore(store, beforeEvent({ id: "call-other-session-assignment", sessionID: SESSION })),
      "cell_not_assigned",
    );
    expect((await readMission(store, PROJECT, SESSION))?.counts.spawns).toBe(0);
  });

  test("finishing a session removes its unspawned assignments, not another session's", async () => {
    const { store } = setup();
    await startMission(store, { sessionID: SESSION });
    await startMission(store, { sessionID: "ses-other" });
    await store.storage.set(assignmentKey(PROJECT, "cell-unspawned-current"), {
      cellID: "cell-unspawned-current",
      agent: "development/typescript-pro",
      sessionID: SESSION,
    });
    await store.storage.set(assignmentKey(PROJECT, "cell-unspawned-other"), {
      cellID: "cell-unspawned-other",
      agent: "vue",
      sessionID: "ses-other",
    });

    await finishMission(store, { projectID: PROJECT, sessionID: SESSION });

    expect(await resolveAssignment(store, PROJECT, "cell-unspawned-current")).toBeUndefined();
    expect(await resolveAssignment(store, PROJECT, "cell-unspawned-other")).toBe("vue");
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
    const { store } = setup();
    const base = await startMission(store);
    await store.save({ ...base, consolidation: value } as unknown as MissionState);
    return { mission: await readMission(store, PROJECT, SESSION), base };
  }

  test("a mission without consolidation stays valid", async () => {
    const { store } = setup();
    await startMission(store);

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

  test("build lock helper refuses a release from a different call token", async () => {
    const { store } = setup();

    expect(await acquireBuildLock(store, PROJECT, SESSION, "call-a", "bun run build")).toBe(true);
    expect(await acquireBuildLock(store, PROJECT, SESSION, "call-b", "bun run test")).toBe(false);
    expect(await releaseBuildLock(store, PROJECT, "call-b")).toBe(false);
    expect(await acquireBuildLock(store, PROJECT, SESSION, "call-b", "bun run test")).toBe(false);
    expect(await releaseBuildLock(store, PROJECT, "call-a")).toBe(true);
    expect(await acquireBuildLock(store, PROJECT, SESSION, "call-b", "bun run test")).toBe(true);
    expect(await releaseBuildLock(store, PROJECT, "call-b")).toBe(true);
  });

  test("setup wires execute.before/after to the mission store", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    await legacySwarmx.setup(ctx as unknown as Plugin.Context);

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

  test("runtime without WorkUnit preserves legacy dispatch reservation and settlement", async () => {
    const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT });
    await legacySwarmx.setup(ctx as unknown as Plugin.Context);

    const beforeHooks = ctx.captures.toolHooks.get("execute.before") ?? [];
    const afterHooks = ctx.captures.toolHooks.get("execute.after") ?? [];
    const legacy = createMissionStateStore(ctx.storage as unknown as MissionStorageLike);
    await startMission(legacy);
    await setAssignment(legacy, PROJECT, "cell-a", "development/typescript-pro");

    const event = beforeEvent({ id: "native-call" });
    await Promise.resolve(beforeHooks[0]?.(event));
    await Promise.resolve(afterHooks[0]?.({ ...event, status: "completed", result: { sessionID: "worker-session" } }));

    expect(await listAttempts(legacy, PROJECT, SESSION)).toMatchObject([
      { callID: "native-call", status: "succeeded", agent: "development/typescript-pro" },
    ]);
    expect((await readMission(legacy, PROJECT, SESSION))?.counts.spawns).toBe(1);
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
