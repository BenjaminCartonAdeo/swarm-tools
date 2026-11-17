/**
 * Dispatch gates for the V2 `subagent` tool.
 *
 * The gate is deliberately strict — there is no heuristic fallback:
 *
 *   - outside an active mission (or for any other tool) both hooks are no-ops;
 *   - the prompt must carry exactly one cell marker and a one-use dispatch token;
 *   - the target agent comes from `input.agent`, is resolved against
 *     `ctx.agent.list()` and must match the recorded cell assignment;
 *   - budget is charged at reservation time, exactly once per `Tool.CallID`.
 *
 * Refusal throws from `execute.before` (the only hook allowed to reject).
 * `settleAfter` never throws: a rejection there would corrupt the host call.
 */
import { randomUUID } from "node:crypto";

import {
  DEFAULT_WORKER_SHARE,
  getAttempt,
  listAttempts,
  putAttempt,
  reconcileCountsFromAttempts,
  readMission,
  resolveAssignment,
  sameMissionGeneration,
  withMissionLock,
} from "./state";
import type { MissionStateStore } from "./state";
import {
  DispatchGateError,
  type CellMarker,
  type DispatchAgentInfo,
  type DispatchAgentList,
  type DispatchAttempt,
  type DispatchAttemptStatus,
  type MissionState,
} from "./types";
import { isSwarmWorkerAgentID } from "./roster";

/** Name of the V2 tool that dispatches a subtask to an agent. */
export const DISPATCH_TOOL_NAME = "subagent";

/**
 * Strict marker form. Exactly one space after `<!--` and before `-->`, exactly
 * one `; ` separator. Anything else is malformed, never guessed.
 */
const CELL_MARKER_PATTERN = /<!-- swarmx:cell=([^\s;<>]+); epic=([^\s;<>]+) -->/g;
const DISPATCH_TOKEN_PATTERN = /<!-- swarmx:dispatch=([a-f0-9-]+) -->/gi;

/** Detects an attempted marker so malformed markers are not reported as absent. */
const MARKER_NEAR_MISS = /<!--\s*swarmx/i;

/** `execute.before` payload (plus an optional explicit project override). */
export interface DispatchBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  /** Calling agent from the V2 hook context; the target is `input.agent`. */
  readonly agent: string;
  readonly messageID?: string;
  /** `Tool.CallID`; the idempotency key of the ledger. */
  readonly id: string;
  readonly input?: unknown;
  readonly projectID?: string;
}

/** `execute.after` payload (`status` discriminates the outcome). */
export type DispatchAfterEvent = DispatchBeforeEvent &
  (
    | { readonly status: "completed"; readonly result: unknown }
    | { readonly status: "error"; readonly error: unknown }
  );

function normalizeAgentList(listed: DispatchAgentList): readonly DispatchAgentInfo[] {
  // `Array.isArray` does not narrow `readonly T[]` out of the union, hence the
  // explicit cast on the `{ data }` branch.
  if (Array.isArray(listed)) return listed as readonly DispatchAgentInfo[];
  return (listed as { readonly data: readonly DispatchAgentInfo[] }).data;
}

async function requireCoordinatorCaller(store: MissionStateStore, callerID: string): Promise<void> {
  const caller = normalizeAgentList(await store.listAgents()).find((agent) => agent.id === callerID);
  const coordinatorIDs = new Set(["swarm/swarm-coordinator", "build", "plan"]);
  if (
    caller === undefined ||
    !coordinatorIDs.has(caller.id) ||
    caller.mode !== "primary" ||
    caller.hidden
  ) {
    throw new DispatchGateError(
      "caller_not_coordinator",
      undefined,
      `agent "${callerID}" cannot dispatch; only a coordinator primary may do so`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function promptCandidates(input: unknown): string[] {
  const record = asRecord(input);
  if (record === undefined) return [];
  const candidates: string[] = [];
  if (typeof record.prompt === "string" && record.prompt.length > 0) candidates.push(record.prompt);
  if (typeof record.description === "string" && record.description.length > 0) {
    candidates.push(record.description);
  }
  return candidates;
}

/**
 * Extracts the unique cell marker from the dispatch input.
 *
 * @throws DispatchGateError `cell_marker_missing` when absent,
 * `cell_marker_malformed` when a near-miss or a duplicate is found.
 */
export function extractCellMarker(input: unknown): CellMarker {
  const candidates = promptCandidates(input);
  if (candidates.length === 0) {
    throw new DispatchGateError(
      "cell_marker_missing",
      undefined,
      "dispatch input has no prompt or description string",
    );
  }
  const matches = candidates.flatMap((text) => [...text.matchAll(CELL_MARKER_PATTERN)]);
  if (matches.length === 0) {
    const attempted = candidates.some((text) => MARKER_NEAR_MISS.test(text));
    throw new DispatchGateError(
      attempted ? "cell_marker_malformed" : "cell_marker_missing",
      undefined,
      "expected exactly one <!-- swarmx:cell=<id>; epic=<id> -->",
    );
  }
  if (matches.length > 1) {
    throw new DispatchGateError(
      "cell_marker_malformed",
      undefined,
      `${matches.length} markers found; expected exactly 1`,
    );
  }
  const marker = matches[0];
  const dispatchTokens = candidates.flatMap((text) => [...text.matchAll(DISPATCH_TOKEN_PATTERN)]);
  if (dispatchTokens.length > 1) {
    throw new DispatchGateError(
      "cell_marker_malformed",
      marker[1],
      `${dispatchTokens.length} dispatch tokens found; expected exactly 1`,
    );
  }
  const dispatchToken = dispatchTokens[0]?.[1];
  return {
    cellID: marker[1],
    epicID: marker[2],
    ...(dispatchToken === undefined ? {} : { dispatchToken }),
  };
}

function attachDispatchToken(input: unknown, dispatchToken: string, cellID: string): void {
  const record = asRecord(input);
  if (record === undefined || typeof record.prompt !== "string") {
    throw new DispatchGateError(
      "dispatch_token_missing",
      cellID,
      "the active mission requires a prompt string so the one-use capability can be attached",
    );
  }
  const prompt = record.prompt;
  const matches = [...prompt.matchAll(DISPATCH_TOKEN_PATTERN)];
  if (matches.length > 1 || (matches.length === 1 && matches[0]?.[1] !== dispatchToken)) {
    throw new DispatchGateError("dispatch_token_reused", cellID, "prompt capability does not match the reserved dispatch");
  }
  if (matches.length === 0) {
    record.prompt = `${prompt}\n\n<!-- swarmx:dispatch=${dispatchToken} -->`;
  }
}

async function requireDispatchableAgent(
  store: MissionStateStore,
  agentID: string,
): Promise<DispatchAgentInfo> {
  const roster = normalizeAgentList(await store.listAgents());
  const found = roster.find((agent) => agent.id === agentID);
  if (found === undefined) {
    throw new DispatchGateError(
      "agent_unknown",
      undefined,
      `agent "${agentID}" is not in the roster; no fallback agent is applied`,
    );
  }
  if (found.hidden || found.mode === "primary") {
    throw new DispatchGateError(
      "agent_not_dispatchable",
      undefined,
      `agent "${found.id}" is ${found.hidden ? "hidden" : "primary"}`,
    );
  }
  return found;
}

async function requireAssignment(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
  marker: CellMarker,
  agent: DispatchAgentInfo,
  agentID: string,
): Promise<void> {
  const assigned = await resolveAssignment(store, projectID, marker.cellID, undefined, { sessionID });
  if (assigned === undefined) {
    throw new DispatchGateError(
      "cell_not_assigned",
      marker.cellID,
      "no assignment recorded; run swarm_set_agent before dispatching",
    );
  }
  if (assigned !== agent.id && assigned !== agent.name && assigned !== agentID) {
    throw new DispatchGateError(
      "assignment_mismatch",
      marker.cellID,
      `assigned "${assigned}", dispatched "${agentID}"`,
    );
  }
}

function chargeBudget(mission: MissionState, marker: CellMarker, agent: DispatchAgentInfo): void {
  const attemptsForCell = mission.counts.attemptsByCell[marker.cellID] ?? 0;
  if (mission.counts.spawns >= mission.budget.maxSpawns) {
    throw new DispatchGateError(
      "budget_exhausted",
      marker.cellID,
      `spawns ${mission.counts.spawns}/${mission.budget.maxSpawns}`,
    );
  }
  if (attemptsForCell >= mission.budget.maxIterations) {
    throw new DispatchGateError(
      "cell_iterations_exhausted",
      marker.cellID,
      `cell attempts ${attemptsForCell}/${mission.budget.maxIterations}`,
    );
  }
  if (isSwarmWorkerAgentID(agent.id)) {
    const share = mission.budget.workerShare ?? DEFAULT_WORKER_SHARE;
    const projected = (mission.counts.workerSpawns + 1) / (mission.counts.spawns + 1);
    if (projected > share) {
      throw new DispatchGateError(
        "worker_share_exceeded",
        marker.cellID,
        `worker share ${projected.toFixed(2)} > ${share}`,
      );
    }
  }
}

/**
 * Reserves one spawn for `event.id`.
 *
 * Runs under the session lock so the ledger entry and the counters move
 * together. A replayed `callID` returns without touching either.
 */
async function reserveSpawn(
  store: MissionStateStore,
  projectID: string,
  event: DispatchBeforeEvent,
  marker: CellMarker,
  agent: DispatchAgentInfo,
  expectedMission: MissionState,
): Promise<
  | { readonly status: "reserved" | "replay"; readonly dispatchToken: string }
  | { readonly status: "mission_inactive" | "mission_changed" }
> {
  return withMissionLock(projectID, event.sessionID, async () => {
    const mission = await readMission(store, projectID, event.sessionID);
    if (mission === undefined || !mission.active) return { status: "mission_inactive" };
    if (!sameMissionGeneration(mission, expectedMission)) return { status: "mission_changed" };
    const attempts = await listAttempts(store, projectID, event.sessionID, mission);
    const reconciliation = reconcileCountsFromAttempts(mission.counts, attempts);
    if (reconciliation.changed) {
      mission.counts = reconciliation.counts;
      mission.updatedAt = store.now();
      await store.save(mission);
    }
    const existing = attempts.find((attempt) => attempt.callID === event.id);
    if (existing !== undefined) {
      const matches =
        existing.cellID === marker.cellID &&
        existing.epicID === marker.epicID &&
        (existing.agent === agent.id || existing.agent === agent.name);
      if (!matches || existing.status !== "pending") {
        throw new DispatchGateError(
          "call_id_conflict",
          marker.cellID,
          "tool call ID is already bound to another or settled dispatch",
        );
      }
      if (
        existing.dispatchToken === undefined ||
        (marker.dispatchToken !== undefined && marker.dispatchToken !== existing.dispatchToken)
      ) {
        throw new DispatchGateError(
          "dispatch_token_reused",
          marker.cellID,
          "the replay prompt does not match the reserved one-use capability",
        );
      }
      return { status: "replay", dispatchToken: existing.dispatchToken };
    }
    if (await getAttempt(store, projectID, event.id)) {
      throw new DispatchGateError(
        "call_id_conflict",
        marker.cellID,
        "tool call ID is already recorded in another mission generation",
      );
    }
    if (marker.dispatchToken !== undefined) {
      throw new DispatchGateError(
        "dispatch_token_reused",
        marker.cellID,
        "a dispatch capability cannot be supplied or reused in a new tool call",
      );
    }
    chargeBudget(mission, marker, agent);
    const attemptsForCell = mission.counts.attemptsByCell[marker.cellID] ?? 0;
    const ts = store.now();
    const dispatchToken = randomUUID();
    const attempt: DispatchAttempt = {
      callID: event.id,
      ...(mission.missionID === undefined ? {} : { missionID: mission.missionID }),
      sessionID: event.sessionID,
      cellID: marker.cellID,
      epicID: marker.epicID,
      agent: agent.id,
      status: "pending",
      ts,
      dispatchToken,
    };
    // Ledger first: a crash between the two writes leaves an orphan that
    // recovery aborts — the counters were never charged twice.
    await putAttempt(store, projectID, attempt);
    mission.counts.spawns += 1;
    if (attemptsForCell === 0) mission.counts.cells += 1;
    mission.counts.attemptsByCell[marker.cellID] = attemptsForCell + 1;
    if (isSwarmWorkerAgentID(agent.id)) mission.counts.workerSpawns += 1;
    mission.updatedAt = ts;
    await store.save(mission);
    return { status: "reserved", dispatchToken };
  });
}

/**
 * Gate evaluated before a `subagent` call executes.
 *
 * Returns immediately — no read of the prompt, no write — when the tool is not
 * the dispatch tool or when no mission is active for the session. Refusals are
 * thrown as {@link DispatchGateError}.
 */
export async function gateBefore(
  store: MissionStateStore,
  event: DispatchBeforeEvent,
): Promise<void> {
  if (event.tool !== DISPATCH_TOOL_NAME) return;
  const projectID = event.projectID ?? store.projectID;
  if (projectID === undefined) return;
  const mission = await readMission(store, projectID, event.sessionID);
  if (mission === undefined || !mission.active) return;
  await requireCoordinatorCaller(store, event.agent);
  if (typeof asRecord(event.input)?.prompt !== "string") {
    throw new DispatchGateError(
      "dispatch_token_missing",
      undefined,
      "native subagent input must include a prompt string",
    );
  }
  const marker = extractCellMarker(event.input);
  const cleanupClaim = asRecord(await store.storage.get(`cleanup-claim:${projectID}`));
  if (
    cleanupClaim !== undefined &&
    typeof cleanupClaim.at === "number" &&
    Date.now() - cleanupClaim.at < 5 * 60_000 &&
    (cleanupClaim.taskID === "*" || cleanupClaim.taskID === marker.cellID)
  ) {
    throw new DispatchGateError(
      "cleanup_in_progress",
      marker.cellID,
      "retry after the worktree cleanup finishes",
    );
  }
  const targetAgentID = asRecord(event.input)?.agent;
  if (typeof targetAgentID !== "string" || targetAgentID.trim().length === 0) {
    throw new DispatchGateError(
      "agent_missing",
      marker.cellID,
      "subagent input must include a non-empty target agent ID",
    );
  }
  if (targetAgentID !== targetAgentID.trim()) {
    throw new DispatchGateError(
      "agent_unknown",
      marker.cellID,
      "subagent input must use the exact V2 agent ID from the roster",
    );
  }
  const dispatchedAgentID = targetAgentID;
  const agent = await requireDispatchableAgent(store, dispatchedAgentID);
  await requireAssignment(store, projectID, event.sessionID, marker, agent, dispatchedAgentID);
  const reservation = await reserveSpawn(store, projectID, event, marker, agent, mission);
  if (reservation.status === "replay" || reservation.status === "reserved") {
    attachDispatchToken(event.input, reservation.dispatchToken, marker.cellID);
    return;
  }
  if (reservation.status === "mission_inactive") {
    throw new DispatchGateError(
      "mission_inactive",
      marker.cellID,
      "mission finished while the dispatch was being validated",
    );
  }
  if (reservation.status === "mission_changed") {
    throw new DispatchGateError(
      "mission_changed",
      marker.cellID,
      "mission restarted while the dispatch was being validated",
    );
  }
}

/**
 * Settles the ledger entry after a `subagent` call.
 *
 * Never throws (the V2 `execute.after` hook must not reject). Duplicate or
 * unknown calls are a no-op: only a `pending` entry transitions, and the
 * counters are never touched here.
 */
export async function settleAfter(
  store: MissionStateStore,
  event: DispatchAfterEvent,
): Promise<void> {
  try {
    if (event.tool !== DISPATCH_TOOL_NAME) return;
    const projectID = event.projectID ?? store.projectID;
    if (projectID === undefined) return;
    await withMissionLock(projectID, event.sessionID, async () => {
      const mission = await readMission(store, projectID, event.sessionID);
      if (mission === undefined || !mission.active) return;
      const attempt = await getAttempt(store, projectID, event.id);
      if (attempt === undefined || attempt.status !== "pending") return;
      const status: DispatchAttemptStatus =
        event.status === "completed" ? "succeeded" : "failed";
      await putAttempt(store, projectID, { ...attempt, status });
    });
  } catch {
    // execute.after must never reject: a ledger write failure is not worth
    // failing the model's tool call.
  }
}
