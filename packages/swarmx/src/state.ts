/**
 * Mission state persistence and the idempotent dispatch ledger.
 *
 * Storage is scoped per plugin (not per session), so every document is
 * namespaced by project and by its own identity:
 *
 *   - `mission:<project>:<session>`    one mission document
 *   - `attempt:<project>:<callID>`     one dispatch ledger entry (exact-once)
 *   - `assignment:<project>:<cell>`    the agent assigned to a cell
 *
 * Mutations run through a per-session async mutex (`withMissionLock`) so
 * read-modify-write on `counts` cannot interleave. Nothing here writes to Hive:
 * assignments are local documents, with a read-only fallback on the
 * `[agent: <id>]` tag when a caller provides the cell text.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  ConsolidationState,
  ConsolidationStatus,
  DispatchAgentLister,
  DispatchAttempt,
  CellMarker,
  IsoTimestamp,
  JsonValue,
  MissionAudit,
  MissionBudget,
  MissionCellSelectorInput,
  MissionCellSnapshot,
  MissionCellStatus,
  MissionCounts,
  MissionMode,
  MissionState,
  MissionSummary,
  RetryCauseRecord,
  RetryRootCause,
} from "./types";
import { isSwarmWorkerAgentID } from "./roster";

/** Prefix of mission documents. */
export const MISSION_KEY_PREFIX = "mission:";

/** Prefix of dispatch ledger entries. */
export const ATTEMPT_KEY_PREFIX = "attempt:";

/** Prefix of cell assignments. */
export const ASSIGNMENT_KEY_PREFIX = "assignment:";

/** Prefix of budget documents. */
export const BUDGET_KEY_PREFIX = "budget:";

/** Default ceiling for the `swarm-worker` share of spawns. */
export const DEFAULT_WORKER_SHARE = 0.2;

/** Storage key of a mission document. */
export function missionKey(projectID: string, sessionID: string): string {
  return `${MISSION_KEY_PREFIX}${projectID}:${sessionID}`;
}

/** Storage key of a dispatch ledger entry. */
export function attemptKey(projectID: string, callID: string): string {
  return `${ATTEMPT_KEY_PREFIX}${projectID}:${callID}`;
}

/** Storage key of a cell assignment. */
export function assignmentKey(projectID: string, cellID: string): string {
  return `${ASSIGNMENT_KEY_PREFIX}${projectID}:${cellID}`;
}

/** Owner recorded on a mission-scoped assignment. */
export interface AssignmentOwner {
  readonly sessionID: string;
}

/** Storage key of a budget document. */
export function budgetKey(projectID: string, sessionID: string): string {
  return `${BUDGET_KEY_PREFIX}${projectID}:${sessionID}`;
}

export interface MissionScanOptions {
  readonly prefix: string;
  readonly after?: string;
  readonly limit?: number;
}

export interface MissionScanEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface MissionScanResult {
  readonly entries: readonly MissionScanEntry[];
  readonly next?: string;
}

/**
 * Narrow storage view needed by the mission store (matches `ctx.storage`).
 *
 * The real domain is `get/set/remove/scan` — there is no `delete` and no
 * `list`, and every method is async.
 */
export interface MissionStorageLike {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: MissionScanOptions): Promise<MissionScanResult>;
}

export interface MissionStateStoreOptions {
  /**
   * Project bound at creation. `gateBefore`/`settleAfter` take two arguments,
   * so the project comes from here (or from an explicit event override).
   */
  readonly projectID?: string;
  /** Roster reader used by the dispatch gate. Defaults to an empty roster. */
  readonly listAgents?: DispatchAgentLister;
  /** Clock override (tests). Defaults to `Date#toISOString`. */
  readonly now?: () => IsoTimestamp;
  /**
   * Pending attempts younger than this are treated as in flight during orphan
   * recovery. Defaults to 0: a load or an audit that follows a crash (no
   * matching `execute.after`) settles the attempt as `aborted` immediately.
   */
  readonly orphanGraceMs?: number;
}

/** Load/save boundary for mission documents plus ledger access. */
export interface MissionStateStore {
  load(projectID: string, sessionID: string): Promise<MissionState | undefined>;
  save(state: MissionState): Promise<void>;
  list(): Promise<MissionState[]>;
  /** Underlying plugin storage, used by the ledger helpers. */
  readonly storage: MissionStorageLike;
  /** Project bound at creation (dispatch gates), when provided. */
  readonly projectID?: string;
  /** Roster reader bound at creation (dispatch gates). */
  readonly listAgents: DispatchAgentLister;
  /** Clock bound at creation. */
  readonly now: () => IsoTimestamp;
  readonly orphanGraceMs: number;
}

const EMPTY_ROSTER: DispatchAgentLister = async () => [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissionBudget(value: unknown): value is MissionBudget {
  return (
    isRecord(value) &&
    typeof value.maxSpawns === "number" &&
    typeof value.maxIterations === "number" &&
    (value.workerShare === undefined || typeof value.workerShare === "number")
  );
}

function isMissionCounts(value: unknown): value is MissionCounts {
  return (
    isRecord(value) &&
    typeof value.spawns === "number" &&
    typeof value.cells === "number" &&
    typeof value.workerSpawns === "number" &&
    isRecord(value.attemptsByCell)
  );
}

const CONSOLIDATION_STATUSES: readonly ConsolidationStatus[] = [
  "pending",
  "ready",
  "dispatched",
  "completed",
];

/** Non-empty trimmed string: ids are never blank once persisted. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConsolidationState(value: unknown): value is ConsolidationState {
  return (
    isRecord(value) &&
    isNonEmptyString(value.epicID) &&
    isNonEmptyString(value.cellID) &&
    CONSOLIDATION_STATUSES.includes(value.status as ConsolidationStatus) &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function isMissionState(value: unknown): value is MissionState {
  return (
    isRecord(value) &&
    (value.missionID === undefined || typeof value.missionID === "string") &&
    typeof value.projectID === "string" &&
    typeof value.sessionID === "string" &&
    typeof value.active === "boolean" &&
    (value.mode === "audit" || value.mode === "dev") &&
    isMissionBudget(value.budget) &&
    isMissionCounts(value.counts) &&
    (value.retryCauses === undefined ||
      (Array.isArray(value.retryCauses) && value.retryCauses.every(isRetryCauseRecord))) &&
    (value.consolidation === undefined || isConsolidationState(value.consolidation)) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRetryCauseRecord(value: unknown): value is RetryCauseRecord {
  return (
    isRecord(value) &&
    (value.failureReason === undefined || typeof value.failureReason === "string") &&
    (value.failedCommand === undefined || typeof value.failedCommand === "string") &&
    (value.errorExcerpt === undefined || typeof value.errorExcerpt === "string") &&
    typeof value.cellID === "string" &&
    typeof value.epicID === "string" &&
    typeof value.attempt === "number" &&
    typeof value.ts === "string"
  );
}

function isDispatchAttempt(value: unknown): value is DispatchAttempt {
  return (
    isRecord(value) &&
    typeof value.callID === "string" &&
    (value.missionID === undefined || typeof value.missionID === "string") &&
    typeof value.sessionID === "string" &&
    typeof value.cellID === "string" &&
    (value.epicID === undefined || typeof value.epicID === "string") &&
    typeof value.agent === "string" &&
    (value.dispatchToken === undefined || typeof value.dispatchToken === "string") &&
    (value.workerSessionID === undefined || typeof value.workerSessionID === "string") &&
    (value.followup === undefined || typeof value.followup === "boolean") &&
    (value.revokedAt === undefined || typeof value.revokedAt === "string") &&
    (value.status === "pending" ||
      value.status === "succeeded" ||
      value.status === "failed" ||
      value.status === "aborted") &&
    typeof value.ts === "string"
  );
}

function emptyCounts(): MissionCounts {
  return { spawns: 0, cells: 0, attemptsByCell: {}, workerSpawns: 0 };
}

function cloneCounts(counts: MissionCounts): MissionCounts {
  return {
    spawns: counts.spawns,
    cells: counts.cells,
    attemptsByCell: { ...counts.attemptsByCell },
    workerSpawns: counts.workerSpawns,
  };
}

/**
 * Reconciles counters with the durable dispatch ledger without ever lowering a
 * persisted ceiling counter. The ledger may be ahead if a process stopped
 * after writing an attempt but before saving the mission document.
 */
export function reconcileCountsFromAttempts(
  current: MissionCounts,
  attempts: readonly DispatchAttempt[],
): { readonly counts: MissionCounts; readonly changed: boolean } {
  const attemptsByCell = { ...current.attemptsByCell };
  const observedByCell: Record<string, number> = {};
  const cells = new Set<string>();
  let workerSpawns = 0;

  for (const attempt of attempts) {
    if (attempt.followup !== true) {
      observedByCell[attempt.cellID] = (observedByCell[attempt.cellID] ?? 0) + 1;
      cells.add(attempt.cellID);
    }
    if (isSwarmWorkerAgentID(attempt.agent)) workerSpawns += 1;
  }
  for (const [cellID, count] of Object.entries(observedByCell)) {
    attemptsByCell[cellID] = Math.max(attemptsByCell[cellID] ?? 0, count);
  }

  const counts: MissionCounts = {
    spawns: Math.max(current.spawns, attempts.length),
    cells: Math.max(current.cells, cells.size),
    attemptsByCell,
    workerSpawns: Math.max(current.workerSpawns, workerSpawns),
  };
  const keys = new Set([...Object.keys(current.attemptsByCell), ...Object.keys(counts.attemptsByCell)]);
  const changed =
    current.spawns !== counts.spawns ||
    current.cells !== counts.cells ||
    current.workerSpawns !== counts.workerSpawns ||
    [...keys].some((key) => current.attemptsByCell[key] !== counts.attemptsByCell[key]);
  return { counts, changed };
}

/** Compares mission identities, using creation time only for legacy documents. */
export function sameMissionGeneration(current: MissionState, expected: MissionState): boolean {
  if (current.missionID !== undefined || expected.missionID !== undefined) {
    return current.missionID === expected.missionID;
  }
  return current.createdAt === expected.createdAt;
}

/** Checks whether a ledger entry belongs to the given mission generation. */
export function attemptBelongsToMission(
  attempt: DispatchAttempt,
  mission: Pick<MissionState, "missionID" | "createdAt" | "sessionID">,
): boolean {
  if (attempt.sessionID !== mission.sessionID) return false;
  if (mission.missionID !== undefined) return attempt.missionID === mission.missionID;
  return attempt.missionID === undefined && attempt.ts >= mission.createdAt;
}

/**
 * Validates and normalizes a budget: integer ceilings, `workerShare` in [0, 1]
 * with a 0.2 default.
 *
 * @throws Error when a ceiling is negative/non-finite.
 */
export function normalizeBudget(budget: MissionBudget): MissionBudget {
  const maxSpawns = Math.floor(budget.maxSpawns);
  const maxIterations = Math.floor(budget.maxIterations);
  const workerShare = budget.workerShare ?? DEFAULT_WORKER_SHARE;
  if (!Number.isFinite(budget.maxSpawns) || maxSpawns < 0) {
    throw new Error("swarmx: maxSpawns must be a non-negative number");
  }
  if (!Number.isFinite(budget.maxIterations) || maxIterations < 0) {
    throw new Error("swarmx: maxIterations must be a non-negative number");
  }
  if (!Number.isFinite(workerShare) || workerShare < 0 || workerShare > 1) {
    throw new Error("swarmx: workerShare must be between 0 and 1");
  }
  return { maxSpawns, maxIterations, workerShare };
}

/**
 * Creates a fresh, active mission document.
 *
 * @param input - identity, mode, normalized budget and optional clock override.
 */
export function createMissionState(input: {
  projectID: string;
  sessionID: string;
  mode?: MissionMode;
  budget: MissionBudget;
  now?: IsoTimestamp;
}): MissionState {
  const ts = input.now ?? new Date().toISOString();
  return {
    missionID: randomUUID(),
    projectID: input.projectID,
    sessionID: input.sessionID,
    active: true,
    mode: input.mode ?? "dev",
    budget: normalizeBudget(input.budget),
    counts: emptyCounts(),
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Async mutex per `(project, session)`; shared by every store instance. */
const locks = new Map<string, Promise<unknown>>();
/** Tracks locks held by the current async chain to reject self-deadlocking re-entry. */
const lockContext = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Serializes `run` behind any in-flight operation for the same session.
 *
 * A rejected operation does not poison the chain: the next caller runs
 * regardless of the previous outcome. Re-entering the same lock from the same
 * async chain throws instead of deadlocking.
 */
export async function withMissionLock<T>(
  projectID: string,
  sessionID: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${projectID}\u0000${sessionID}`;
  const held = lockContext.getStore();
  if (held?.has(key) === true) {
    throw new Error(`reentrant mission lock: ${projectID}/${sessionID}`);
  }
  const nextHeld = new Set(held ?? []);
  nextHeld.add(key);
  return lockContext.run(nextHeld, async () => {
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    try {
      return await result;
    } finally {
      if (locks.get(key) === settled) locks.delete(key);
    }
  });
}

async function scanAll(
  storage: MissionStorageLike,
  prefix: string,
): Promise<MissionScanEntry[]> {
  const entries: MissionScanEntry[] = [];
  let after: string | undefined;
  // Bounded to avoid an infinite loop if a storage implementation misbehaves.
  for (let page = 0; page < 10_000; page += 1) {
    const result = await storage.scan(after === undefined ? { prefix } : { prefix, after });
    entries.push(...result.entries);
    if (result.next === undefined || result.entries.length === 0) break;
    after = result.next;
  }
  return entries;
}

/**
 * Creates the persistent store over `ctx.storage`.
 *
 * @param storage - plugin-scoped storage (`get/set/remove/scan`).
 * @param options - bound project, roster reader, clock and orphan grace.
 */
export function createMissionStateStore(
  storage: MissionStorageLike,
  options: MissionStateStoreOptions = {},
): MissionStateStore {
  const store: MissionStateStore = {
    storage,
    projectID: options.projectID,
    listAgents: options.listAgents ?? EMPTY_ROSTER,
    now: options.now ?? (() => new Date().toISOString()),
    orphanGraceMs: options.orphanGraceMs ?? 0,
    async load(projectID, sessionID) {
      const mission = await readMission(store, projectID, sessionID);
      if (mission === undefined) return undefined;
      await recoverPendingOrphans(store, projectID, sessionID);
      await reconcileMissionCounts(store, projectID, sessionID);
      return readMission(store, projectID, sessionID);
    },
    async save(state) {
      await storage.set(missionKey(state.projectID, state.sessionID), state as unknown as JsonValue);
    },
    async list() {
      const entries = await scanAll(storage, MISSION_KEY_PREFIX);
      return entries
        .map((entry) => entry.value)
        .filter(isMissionState)
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? missionKey(left.projectID, left.sessionID).localeCompare(
                missionKey(right.projectID, right.sessionID),
              )
            : left.createdAt.localeCompare(right.createdAt),
        );
    },
  };
  return store;
}

/** Reads a mission without running orphan recovery. */
export async function readMission(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
): Promise<MissionState | undefined> {
  const raw = await store.storage.get(missionKey(projectID, sessionID));
  return isMissionState(raw) ? raw : undefined;
}

/** Reads one ledger entry by call id. */
export async function getAttempt(
  store: MissionStateStore,
  projectID: string,
  callID: string,
): Promise<DispatchAttempt | undefined> {
  const raw = await store.storage.get(attemptKey(projectID, callID));
  return isDispatchAttempt(raw) ? raw : undefined;
}

/** Writes one ledger entry by call id. */
export async function putAttempt(
  store: MissionStateStore,
  projectID: string,
  attempt: DispatchAttempt,
): Promise<void> {
  await store.storage.set(attemptKey(projectID, attempt.callID), attempt as unknown as JsonValue);
}

export type WorkerAttemptBindingResult =
  | {
      readonly status: "bound" | "already_bound";
      readonly attempt: DispatchAttempt;
      readonly missionID: string;
    }
  | {
      readonly status: "not_owner" | "not_found" | "revoked" | "inactive" | "invalid_status";
    };

/** Prefix of the project-scoped build/test lock. */
const BUILD_LOCK_PREFIX = "build-lock:";
const BUILD_LOCK_TTL_MS = 15 * 60 * 1000;

function buildLockKey(projectID: string): string {
  return `${BUILD_LOCK_PREFIX}${projectID}`;
}

/** Acquires the project build lock. Returns false when another build is active. */
export async function acquireBuildLock(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
  callID: string,
  command: string,
): Promise<boolean> {
  return withMissionLock(projectID, "__build__", async () => {
    const key = buildLockKey(projectID);
    const raw = await store.storage.get(key);
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const acquiredAt = typeof record?.acquiredAt === "string" ? Date.parse(record.acquiredAt) : 0;
    const active = Number.isFinite(acquiredAt) && Date.now() - acquiredAt < BUILD_LOCK_TTL_MS;
    if (active && record?.callID !== callID) return false;
    await store.storage.set(key, {
      projectID,
      sessionID,
      callID,
      command,
      acquiredAt: store.now(),
    });
    return true;
  });
}

/** Releases the project build lock when the owning shell call settles. */
export async function releaseBuildLock(
  store: MissionStateStore,
  projectID: string,
  callID: string,
): Promise<boolean> {
  return withMissionLock(projectID, "__build__", async () => {
    const key = buildLockKey(projectID);
    const raw = await store.storage.get(key);
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
    if (record?.callID !== callID) return false;
    await store.storage.remove(key);
    return true;
  });
}

/**
 * Atomically binds a dispatched attempt to its worker session on first use.
 *
 * The dispatch token is the capability: cell, epic, agent and token must all
 * match an active, unrevoked attempt. An unbound attempt is claimed by exactly
 * one worker session; a different session can never reuse it.
 */
export async function bindWorkerAttemptSession(
  store: MissionStateStore,
  projectID: string,
  parentSessionID: string,
  workerSessionID: string,
  marker: CellMarker,
  agentID: string,
): Promise<WorkerAttemptBindingResult> {
  return withMissionLock(projectID, parentSessionID, async () => {
    const mission = await readMission(store, projectID, parentSessionID);
    if (mission === undefined || !mission.active) return { status: "inactive" };
    const attempts = await listAttempts(store, projectID, parentSessionID, mission);
    const attempt = attempts.find(
      (candidate) =>
        candidate.dispatchToken === marker.dispatchToken &&
        candidate.cellID === marker.cellID &&
        candidate.epicID === marker.epicID &&
        candidate.agent === agentID,
    );
    if (attempt === undefined) return { status: "not_found" };
    if (attempt.revokedAt !== undefined) return { status: "revoked" };
    if (attempt.status !== "pending" && attempt.status !== "succeeded") {
      return { status: "invalid_status" };
    }
    const missionID = mission.missionID ?? `legacy:${mission.createdAt}`;
    if (attempt.workerSessionID === undefined) {
      const bound = { ...attempt, workerSessionID };
      await putAttempt(store, projectID, bound);
      return { status: "bound", attempt: bound, missionID };
    }
    if (attempt.workerSessionID !== workerSessionID) return { status: "not_owner" };
    return { status: "already_bound", attempt, missionID };
  });
}

/**
 * Lists ledger entries, optionally restricted to one session and mission generation.
 *
 * Sorted by timestamp then call id so audits and recovery are deterministic.
 */
export async function listAttempts(
  store: MissionStateStore,
  projectID: string,
  sessionID?: string,
  mission?: Pick<MissionState, "missionID" | "createdAt" | "sessionID">,
): Promise<DispatchAttempt[]> {
  const entries = await scanAll(store.storage, `${ATTEMPT_KEY_PREFIX}${projectID}:`);
  return entries
    .map((entry) => entry.value)
    .filter(isDispatchAttempt)
    .filter((attempt) => sessionID === undefined || attempt.sessionID === sessionID)
    .filter((attempt) => mission === undefined || attemptBelongsToMission(attempt, mission))
    .sort((left, right) =>
      left.ts === right.ts ? left.callID.localeCompare(right.callID) : left.ts.localeCompare(right.ts),
    );
}

/** Reconciles one mission's counters from its durable attempt ledger. */
async function reconcileMissionCountsLocked(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
  mission: MissionState,
): Promise<DispatchAttempt[]> {
  const attempts = await listAttempts(store, projectID, sessionID, mission);
  const reconciliation = reconcileCountsFromAttempts(mission.counts, attempts);
  if (reconciliation.changed) {
    mission.counts = reconciliation.counts;
    mission.updatedAt = store.now();
    await store.save(mission);
  }
  return attempts;
}

/** Reconciles a replayed reservation under the mission lock before allowing it. */
export async function reconcileMissionCounts(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
  expectedMission?: MissionState,
): Promise<"reconciled" | "missing" | "inactive" | "changed"> {
  return withMissionLock(projectID, sessionID, async () => {
    const mission = await readMission(store, projectID, sessionID);
    if (mission === undefined) return "missing";
    if (expectedMission !== undefined) {
      if (!mission.active) return "inactive";
      if (!sameMissionGeneration(mission, expectedMission)) return "changed";
    }
    await reconcileMissionCountsLocked(store, projectID, sessionID, mission);
    return "reconciled";
  });
}

/**
 * Reports pending attempts for explicit reconciliation without changing them.
 * An elapsed grace period cannot establish whether a worker is still live.
 *
 * @returns How many pending attempts remain candidates for reconciliation.
 */
export async function recoverPendingOrphans(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
): Promise<number> {
  const mission = await readMission(store, projectID, sessionID);
  const attempts = await listAttempts(store, projectID, sessionID, mission);
  return attempts.filter((attempt) => attempt.status === "pending").length;
}

export interface SetBudgetInput {
  readonly projectID: string;
  readonly sessionID: string;
  readonly mode: MissionMode;
  readonly maxSpawns: number;
  readonly maxIterations: number;
  readonly workerShare?: number;
}

/**
 * Creates the mission with its budget.
 *
 * A budget is fixed once per mission: calling this while a mission is active
 * for the same `(project, session)` throws. A finished mission can be replaced
 * by a fresh one (counters reset).
 */
export async function setBudget(
  store: MissionStateStore,
  input: SetBudgetInput,
): Promise<MissionState> {
  const budget = normalizeBudget({
    maxSpawns: input.maxSpawns,
    maxIterations: input.maxIterations,
    ...(input.workerShare === undefined ? {} : { workerShare: input.workerShare }),
  });
  return withMissionLock(input.projectID, input.sessionID, async () => {
    const existing = await readMission(store, input.projectID, input.sessionID);
    if (existing !== undefined && existing.active) {
      throw new Error(
        `swarmx: mission budget already set for session ${input.sessionID} ` +
          `(${existing.budget.maxSpawns} spawns / ${existing.budget.maxIterations} iterations); ` +
          "the budget is fixed once per mission — run swarm_finish before setting a new one",
      );
    }
    const state = createMissionState({
      projectID: input.projectID,
      sessionID: input.sessionID,
      mode: input.mode,
      budget,
      now: store.now(),
    });
    await store.save(state);
    return state;
  });
}

/** Marks the mission inactive. No-op when it does not exist or is already over. */
export async function finishMission(
  store: MissionStateStore,
  input: { readonly projectID: string; readonly sessionID: string; readonly abandon?: boolean },
): Promise<MissionState | undefined> {
  return withMissionLock(input.projectID, input.sessionID, async () => {
    const mission = await readMission(store, input.projectID, input.sessionID);
    if (mission === undefined) return undefined;
    if (!mission.active) return mission;
    const attempts = await listAttempts(store, input.projectID, input.sessionID, mission);
    if (input.abandon === true) {
      // Abandon: revoke all pending/succeeded attempts so the mission can close.
      for (const attempt of attempts) {
        if (attempt.revokedAt === undefined && (attempt.status === "pending" || attempt.status === "succeeded")) {
          await putAttempt(store, input.projectID, { ...attempt, revokedAt: store.now() });
        }
      }
    } else if (
      attempts.some(
        (attempt) =>
          attempt.revokedAt === undefined &&
          (attempt.status === "pending" || attempt.status === "succeeded"),
      )
    ) {
      throw new Error("mission has unrevoked worker attempts");
    }
    mission.active = false;
    mission.updatedAt = store.now();
    await store.save(mission);
    await store.storage.remove(budgetKey(input.projectID, input.sessionID));
    await removeSessionAssignments(store, input.projectID, input.sessionID);
    return mission;
  });
}

/** Maximum retry causes retained per mission; oldest records are dropped. */
export const MAX_RETRY_CAUSES = 20;

export interface RecordRetryCauseInput {
  readonly projectID: string;
  readonly sessionID: string;
  readonly cellID: string;
  readonly epicID: string;
  readonly attempt: number;
  readonly cause: RetryRootCause;
}

/**
 * Appends one retry root cause to the mission document.
 *
 * @returns the persisted record, or `undefined` when the session has no mission
 * (nothing to audit against) — the retry itself is not blocked by that.
 */
export async function recordRetryCause(
  store: MissionStateStore,
  input: RecordRetryCauseInput,
): Promise<RetryCauseRecord | undefined> {
  return withMissionLock(input.projectID, input.sessionID, async () => {
    const mission = await readMission(store, input.projectID, input.sessionID);
    if (mission === undefined) return undefined;
    const record: RetryCauseRecord = {
      ...input.cause,
      cellID: input.cellID,
      epicID: input.epicID,
      attempt: input.attempt,
      ts: store.now(),
    };
    mission.retryCauses = [...(mission.retryCauses ?? []), record].slice(-MAX_RETRY_CAUSES);
    mission.updatedAt = record.ts;
    await store.save(mission);
    return record;
  });
}

/** Resets a mission: removes its document, attempts, and assignments. */
export async function resetMission(
  store: MissionStateStore,
  input: { readonly projectID: string; readonly sessionID: string },
): Promise<void> {
  return withMissionLock(input.projectID, input.sessionID, async () => {
    const attempts = await listAttempts(store, input.projectID, input.sessionID);
    for (const attempt of attempts) {
      await store.storage.remove(attemptKey(input.projectID, attempt.callID));
    }
    await removeSessionAssignments(store, input.projectID, input.sessionID);
    await store.storage.remove(missionKey(input.projectID, input.sessionID));
    await store.storage.remove(budgetKey(input.projectID, input.sessionID));
  });
}

/** Removes only assignments explicitly owned by one session. */
async function removeSessionAssignments(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
): Promise<void> {
  const entries = await scanAll(store.storage, `${ASSIGNMENT_KEY_PREFIX}${projectID}:`);
  for (const entry of entries) {
    // <!-- ponytail: Unowned legacy entries cannot be attributed safely, so preserve them. -->
    if (isRecord(entry.value) && entry.value.sessionID === sessionID) {
      await store.storage.remove(entry.key);
    }
  }
}

/** Records the agent assigned to a cell. Storage only — never a Hive write. */
export async function setAssignment(
  store: MissionStateStore,
  projectID: string,
  cellID: string,
  agent: string,
  owner?: AssignmentOwner,
): Promise<void> {
  await store.storage.set(assignmentKey(projectID, cellID), {
    cellID,
    agent,
    updatedAt: store.now(),
    ...(owner === undefined ? {} : { sessionID: owner.sessionID }),
  });
}

/**
 * Reads the agent assigned to a cell.
 *
 * Storage is authoritative. When `cellText` is provided (e.g. the cell
 * description), a read-only best-effort fallback parses an `[agent: <id>]` tag.
 * Nothing is ever written to Hive.
 */
export async function resolveAssignment(
  store: MissionStateStore,
  projectID: string,
  cellID: string,
  cellText?: string,
  owner?: AssignmentOwner,
): Promise<string | undefined> {
  const raw = await store.storage.get(assignmentKey(projectID, cellID));
  if (isRecord(raw)) {
    if (owner !== undefined && raw.sessionID !== undefined && raw.sessionID !== owner.sessionID) {
      return undefined;
    }
    if (typeof raw.agent === "string" && raw.agent.length > 0) return raw.agent;
  }
  if (cellText !== undefined) return parseAgentTag(cellText);
  return undefined;
}

const AGENT_TAG = /\[agent:\s*([^\s\]]+)\s*\]/;

/** Parses the read-only `[agent: <id>]` tag used by cell descriptions. */
export function parseAgentTag(text: string): string | undefined {
  const match = AGENT_TAG.exec(text);
  return match === null ? undefined : match[1];
}

/**
 * Lists every cell assignment recorded for a project, sorted by cell id.
 *
 * Read-only: this never falls back to Hive and never writes.
 */
export async function listAssignments(
  store: MissionStateStore,
  projectID: string,
): Promise<Readonly<Record<string, string>>> {
  const entries = await scanAll(store.storage, `${ASSIGNMENT_KEY_PREFIX}${projectID}:`);
  const pairs: Array<readonly [string, string]> = [];
  for (const entry of entries) {
    if (!isRecord(entry.value)) continue;
    const { cellID, agent } = entry.value;
    if (typeof cellID !== "string" || cellID.length === 0) continue;
    if (typeof agent !== "string" || agent.length === 0) continue;
    pairs.push([cellID, agent]);
  }
  pairs.sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(pairs);
}

/** Stable attempt order: timestamp, then call id. */
function compareAttempts(left: DispatchAttempt, right: DispatchAttempt): number {
  return left.ts === right.ts ? left.callID.localeCompare(right.callID) : left.ts.localeCompare(right.ts);
}

/** Mission facts derived from one mission document; `undefined` when absent. */
export function selectMissionSummary(state: MissionState | undefined): MissionSummary | undefined {
  if (state === undefined) return undefined;
  const usedIterations = Object.values(state.counts.attemptsByCell);
  const mostUsed = usedIterations.length === 0 ? 0 : Math.max(...usedIterations);
  return {
    active: state.active,
    mode: state.mode,
    budget: { ...state.budget },
    counts: cloneCounts(state.counts),
    remainingSpawns: Math.max(0, state.budget.maxSpawns - state.counts.spawns),
    remainingIterations: Math.max(0, state.budget.maxIterations - mostUsed),
    workerShare: state.budget.workerShare ?? DEFAULT_WORKER_SHARE,
  };
}

function statusFromAttempt(attempt: DispatchAttempt): MissionCellStatus {
  switch (attempt.status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "in_progress";
    case "aborted":
      return "pending";
  }
}

/**
 * Projects the mission cells known to the plugin.
 *
 * Sources are merged deterministically: an explicit Hive snapshot wins, then
 * the ledger, then the assignment documents and the mission counters. Cells are
 * sorted by id so audits and compaction text are stable.
 */
export function selectCells(input: MissionCellSelectorInput = {}): MissionCellSnapshot[] {
  const { state, attempts = [], assignments = {}, cells = [] } = input;
  const countsByCell = state?.counts.attemptsByCell ?? {};
  const snapshotById = new Map(cells.map((cell) => [cell.id, cell]));
  const attemptsByCell = new Map<string, DispatchAttempt[]>();
  for (const attempt of [...attempts].sort(compareAttempts)) {
    const bucket = attemptsByCell.get(attempt.cellID);
    if (bucket === undefined) attemptsByCell.set(attempt.cellID, [attempt]);
    else bucket.push(attempt);
  }

  const ids = new Set<string>([
    ...Object.keys(countsByCell),
    ...Object.keys(assignments),
    ...attemptsByCell.keys(),
    ...snapshotById.keys(),
  ]);

  const projected: MissionCellSnapshot[] = [];
  for (const id of ids) {
    if (id.length === 0) continue;
    const snapshot = snapshotById.get(id);
    const cellAttempts = attemptsByCell.get(id) ?? [];
    const last = cellAttempts.at(-1);
    const status = snapshot?.status ?? (last === undefined ? undefined : statusFromAttempt(last));
    const agent = snapshot?.agent ?? assignments[id] ?? last?.agent;
    projected.push({
      id,
      ...(snapshot?.title === undefined ? {} : { title: snapshot.title }),
      ...(status === undefined ? {} : { status }),
      ...(agent === undefined ? {} : { agent }),
      attempts: Math.max(snapshot?.attempts ?? 0, countsByCell[id] ?? 0, cellAttempts.length),
      ...(snapshot?.dependsOn === undefined ? {} : { dependsOn: snapshot.dependsOn }),
      ...(snapshot?.epicID === undefined ? {} : { epicID: snapshot.epicID }),
    });
  }
  return projected.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Ready cells: `pending`/`open`, and every `dependsOn` id already `completed`.
 *
 * `blocked`, `in_progress`, `failed` and `completed` cells are never ready.
 */
export function selectReadyCells(cells: readonly MissionCellSnapshot[]): MissionCellSnapshot[] {
  const completed = new Set(
    cells.filter((cell) => cell.status === "completed").map((cell) => cell.id),
  );
  return cells
    .filter((cell) => {
      const status = cell.status ?? "pending";
      if (status !== "pending" && status !== "open") return false;
      return (cell.dependsOn ?? []).every((dependency) => completed.has(dependency));
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * `pending` ledger entries: attempts reserved by `execute.before` that no
 * `execute.after` settled (recoverable orphans). Sorted deterministically.
 */
export function selectPendingOrphans(attempts: readonly DispatchAttempt[]): DispatchAttempt[] {
  return attempts
    .filter((attempt) => attempt.status === "pending")
    .sort(compareAttempts);
}

/** One epic child as reported by the read-only cell lister. */
export interface ConsolidationCellSummary {
  readonly id: string;
  readonly status: string;
  readonly title?: string;
}

/** Cell and prompt produced by the injected consolidation creator. */
export interface PreparedConsolidationCell {
  readonly cellID: string;
  readonly prompt: string;
}

/** Inputs of {@link maybePrepareConsolidation}. */
export interface MaybePrepareConsolidationInput {
  readonly projectID: string;
  readonly sessionID: string;
  readonly epicID: string;
  /** Read-only epic lister (Hive). Injected so this module stays storage-only. */
  readonly listCells: (epicID: string) => Promise<readonly ConsolidationCellSummary[]>;
  /**
   * Creates + assigns + starts the consolidation cell and renders its dispatch
   * prompt. The plugin never spawns: the coordinator consumes the prompt.
   */
  readonly prepareCell: (
    cells: readonly ConsolidationCellSummary[],
  ) => Promise<PreparedConsolidationCell>;
}

/**
 * Terminal Hive statuses for consolidation detection.
 *
 * Hive closes cells as `closed`; `completed`/`done` are accepted so an
 * externally synced snapshot is not treated as in-flight.
 */
export function isConsolidationCellFinished(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "closed" || normalized === "completed" || normalized === "done";
}

/**
 * Prepares the epic consolidation cell once every epic child is finished.
 *
 * Idempotent and serialized by {@link withMissionLock}: an existing
 * `mission.consolidation` is returned as-is, so two parallel approvals create
 * at most one cell. Returns `undefined` while a cell is still in flight, when
 * the epic has no children, or when the mission is absent/inactive.
 */
export async function maybePrepareConsolidation(
  store: MissionStateStore,
  input: MaybePrepareConsolidationInput,
): Promise<ConsolidationState | undefined> {
  return withMissionLock(input.projectID, input.sessionID, async () => {
    const mission = await readMission(store, input.projectID, input.sessionID);
    if (mission === undefined || !mission.active) return undefined;
    if (mission.consolidation !== undefined) return mission.consolidation;

    const cells = (await input.listCells(input.epicID)).filter(
      (cell) => cell.id !== input.epicID,
    );
    if (cells.length === 0) return undefined;
    if (cells.some((cell) => !isConsolidationCellFinished(cell.status))) return undefined;

    const prepared = await input.prepareCell(cells);
    const consolidation: ConsolidationState = {
      epicID: input.epicID,
      cellID: prepared.cellID,
      status: "ready",
      prompt: prepared.prompt,
      createdAt: Date.now(),
    };
    mission.consolidation = consolidation;
    mission.updatedAt = store.now();
    await store.save(mission);
    return consolidation;
  });
}

/**
 * Marks the epic consolidation as `completed` once its cell is approved.
 *
 * The plugin cannot observe the worker's own completion: the coordinator's
 * approval of the consolidation cell is the signal. No-op for any other cell,
 * so it is safe to call on every approval.
 */
export async function completeConsolidation(
  store: MissionStateStore,
  input: { readonly projectID: string; readonly sessionID: string; readonly cellID: string },
): Promise<ConsolidationState | undefined> {
  return withMissionLock(input.projectID, input.sessionID, async () => {
    const mission = await readMission(store, input.projectID, input.sessionID);
    const consolidation = mission?.consolidation;
    if (mission === undefined || consolidation === undefined) return undefined;
    if (consolidation.cellID !== input.cellID) return undefined;
    if (consolidation.status === "completed") return consolidation;
    consolidation.status = "completed";
    mission.updatedAt = store.now();
    await store.save(mission);
    return consolidation;
  });
}

/**
 * Structured mission summary for `swarm_agent_audit`.
 *
 * Reports pending attempts as reconciliation candidates without changing
 * their status; elapsed time alone cannot establish that a worker is gone.
 */
export async function audit(
  store: MissionStateStore,
  projectID: string,
  sessionID: string,
): Promise<MissionAudit> {
  return withMissionLock(projectID, sessionID, async () => {
    const pendingOrphans = await recoverPendingOrphans(store, projectID, sessionID);
    const mission = await readMission(store, projectID, sessionID);
    const attempts =
      mission === undefined
        ? await listAttempts(store, projectID, sessionID)
        : await reconcileMissionCountsLocked(store, projectID, sessionID, mission);
    return {
      active: mission?.active ?? false,
      mode: mission?.mode,
      budget: mission === undefined ? undefined : { ...mission.budget },
      counts: mission === undefined ? undefined : cloneCounts(mission.counts),
      attempts,
      pendingOrphans,
      ...(mission?.consolidation === undefined
        ? {}
        : { consolidation: { ...mission.consolidation } }),
    };
  });
}
