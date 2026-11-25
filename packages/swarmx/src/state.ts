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
 * WorkUnit owns the lifecycle. This KV view is a read-only fallback kept for
 * the legacy import: the only write left is the migration tombstone.
 */
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
  /** Project bound at creation (dispatch hooks fall back to it). */
  readonly projectID?: string;
  /** Roster reader used by the dispatch gate. Defaults to an empty roster. */
  readonly listAgents?: DispatchAgentLister;
  /** Clock override (tests). Defaults to `Date#toISOString`. */
  readonly now?: () => IsoTimestamp;
}

/** Core load/save/list boundary for mission documents, backend-agnostic. */
export interface MissionStore {
  load(projectID: string, sessionID: string): Promise<MissionState | undefined>;
  save(state: MissionState): Promise<void>;
  list(): Promise<MissionState[]>;
}

/** Legacy KV mission store: the core contract plus ledger access over plugin storage. */
export interface LegacyMissionStateStore extends MissionStore {
  /** Underlying plugin storage, used by the ledger helpers. */
  readonly storage: MissionStorageLike;
  /** Project bound at creation (dispatch gates), when provided. */
  readonly projectID?: string;
  /** Roster reader bound at creation (dispatch gates). */
  readonly listAgents: DispatchAgentLister;
  /** Clock bound at creation. */
  readonly now: () => IsoTimestamp;
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
): LegacyMissionStateStore {
  const store: LegacyMissionStateStore = {
    storage,
    projectID: options.projectID,
    listAgents: options.listAgents ?? EMPTY_ROSTER,
    now: options.now ?? (() => new Date().toISOString()),
    // Read-only fallback: never repairs orphans or counters on load.
    load: (projectID, sessionID) => readMission(store, projectID, sessionID),
    async save(state) {
      await assertLegacyLifecycleWritable(store, state.projectID, state.sessionID);
      throw new LegacyLifecycleReadOnlyError(state.projectID);
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
  store: LegacyMissionStateStore,
  projectID: string,
  sessionID: string,
): Promise<MissionState | undefined> {
  const raw = await store.storage.get(missionKey(projectID, sessionID));
  return isMissionState(raw) ? raw : undefined;
}

/** Prefix of the project-scoped build/test lock. */
const BUILD_LOCK_PREFIX = "build-lock:";

function buildLockKey(projectID: string): string {
  return `${BUILD_LOCK_PREFIX}${projectID}`;
}

/**
 * Lists ledger entries, optionally restricted to one session and mission generation.
 *
 * Sorted by timestamp then call id so audits and recovery are deterministic.
 */
export async function listAttempts(
  store: LegacyMissionStateStore,
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

/**
 * Lists every cell assignment recorded for a project, sorted by cell id.
 *
 * Read-only: this never falls back to Hive and never writes.
 */
export async function listAssignments(
  store: LegacyMissionStateStore,
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

// ---------------------------------------------------------------------------
// Legacy lifecycle cutover: read-only KV view + write tombstone.
// ---------------------------------------------------------------------------

/** Prefix of the KV tombstone written once the legacy lifecycle was imported. */
export const LEGACY_TOMBSTONE_PREFIX = "legacy-tombstone:";
/** Session marker of the project-wide tombstone. */
export const LEGACY_TOMBSTONE_PROJECT_SESSION = "*";

export function legacyTombstoneKey(projectID: string, sessionID: string): string {
  return `${LEGACY_TOMBSTONE_PREFIX}${projectID}:${sessionID}`;
}

/** Raised when a lifecycle write targets KV after the legacy import tombstone. */
export class LegacyLifecycleTombstonedError extends Error {
  readonly projectID: string;
  constructor(projectID: string) {
    super(`Legacy lifecycle state for project ${projectID} was imported; KV writes are read-only`);
    this.name = "LegacyLifecycleTombstonedError";
    this.projectID = projectID;
  }
}

/** Raised for any lifecycle write through the legacy KV store: WorkUnit owns writes. */
export class LegacyLifecycleReadOnlyError extends Error {
  readonly projectID: string;
  constructor(projectID: string) {
    super(`Legacy lifecycle state for project ${projectID} is a read-only fallback; WorkUnit owns lifecycle writes`);
    this.name = "LegacyLifecycleReadOnlyError";
    this.projectID = projectID;
  }
}

async function assertLegacyLifecycleWritable(
  store: Pick<LegacyMissionStateStore, "storage">,
  projectID: string,
  sessionID: string | undefined,
): Promise<void> {
  if (await isLegacyLifecycleTombstoned(store.storage, projectID, sessionID)) {
    throw new LegacyLifecycleTombstonedError(projectID);
  }
}

/** True when the project-wide (`*`) or the session tombstone exists. */
export async function isLegacyLifecycleTombstoned(
  storage: Pick<MissionStorageLike, "get">,
  projectID: string,
  sessionID: string | undefined,
): Promise<boolean> {
  const keys = [legacyTombstoneKey(projectID, LEGACY_TOMBSTONE_PROJECT_SESSION)];
  if (sessionID !== undefined) keys.push(legacyTombstoneKey(projectID, sessionID));
  for (const key of keys) {
    if ((await storage.get(key)) !== undefined) return true;
  }
  return false;
}

/** Plain-prefix lifecycle keys: `<prefix><project>:<session|id>` or `<prefix><project>`. */
const PLAIN_LIFECYCLE_PREFIXES = [
  { prefix: MISSION_KEY_PREFIX, sessionScoped: true },
  { prefix: BUDGET_KEY_PREFIX, sessionScoped: true },
  { prefix: ATTEMPT_KEY_PREFIX, sessionScoped: false },
  { prefix: ASSIGNMENT_KEY_PREFIX, sessionScoped: false },
  { prefix: "build-lock:", sessionScoped: false },
  { prefix: "cleanup-claim:", sessionScoped: false },
] as const;
/** URI-encoded lifecycle keys written by catalog.ts: `enc(prefix):enc(project):...`. */
const ENCODED_LIFECYCLE_PREFIXES = [
  { prefix: `${encodeURIComponent("pending-completion:")}:`, sessionScoped: false },
  { prefix: `${encodeURIComponent("review-receipt:")}:`, sessionScoped: true },
] as const;

/** Project/session targeted by a lifecycle key; `undefined` for non-lifecycle keys. */
export function lifecycleKeyScope(key: string): { projectID: string; sessionID?: string } | undefined {
  for (const { prefix, sessionScoped } of PLAIN_LIFECYCLE_PREFIXES) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const cut = rest.indexOf(":");
    if (cut < 0) return { projectID: rest };
    const projectID = rest.slice(0, cut);
    return sessionScoped ? { projectID, sessionID: rest.slice(cut + 1) } : { projectID };
  }
  for (const { prefix, sessionScoped } of ENCODED_LIFECYCLE_PREFIXES) {
    if (!key.startsWith(prefix)) continue;
    const [project, session] = key.slice(prefix.length).split(":");
    const projectID = decodeURIComponent(project ?? "");
    return sessionScoped && session !== undefined
      ? { projectID, sessionID: decodeURIComponent(session) }
      : { projectID };
  }
  return undefined;
}

/**
 * Wraps plugin storage so every lifecycle `set`/`remove` is refused once the
 * project (or session) is tombstoned. Reads and scans pass through untouched.
 */
export function createTombstoneGuardedStorage<S extends MissionStorageLike>(storage: S): S {
  const guard = async (key: string): Promise<void> => {
    const scope = lifecycleKeyScope(key);
    if (scope !== undefined && (await isLegacyLifecycleTombstoned(storage, scope.projectID, scope.sessionID))) {
      throw new LegacyLifecycleTombstonedError(scope.projectID);
    }
  };
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "set") {
        return async (key: string, value: unknown) => {
          await guard(key);
          return target.set(key, value);
        };
      }
      if (property === "remove") {
        return async (key: string) => {
          await guard(key);
          return target.remove(key);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface LegacyAssignment {
  readonly cellID: string;
  readonly agent: string;
  readonly updatedAt: IsoTimestamp;
  readonly sessionID?: string;
}

export interface LegacyPendingCompletion {
  readonly projectID: string;
  readonly parentSessionID: string;
  readonly missionID: string;
  readonly workerSessionID: string;
  readonly taskID: string;
  readonly epicID: string;
  readonly workerAgentID: string;
  readonly attemptCallID: string;
  readonly dispatchToken: string;
  readonly summary: string;
  readonly filesTouched: readonly string[];
  readonly submittedAt: number;
  readonly finalized?: boolean;
  readonly canceled?: boolean;
  readonly cancelReason?: string;
  readonly verification?: unknown;
  readonly [extra: string]: unknown;
}

export interface LegacyReviewReceipt {
  readonly projectID: string;
  readonly sessionID: string;
  readonly missionID: string;
  readonly taskID: string;
  readonly assignedAgentID: string;
  readonly attemptCallID: string;
  readonly dispatchToken: string;
  readonly diffHash: string;
  readonly reviewedAt: number;
  readonly approval?: { readonly diffHash: string; readonly approvedAt: number; readonly [extra: string]: unknown };
  readonly [extra: string]: unknown;
}

export interface LegacyBuildLock {
  readonly projectID: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly command: string;
  readonly acquiredAt: IsoTimestamp;
}

export interface LegacyCleanupClaim {
  readonly taskID: string;
  readonly at: number;
}

/** Read-only view over the legacy KV lifecycle documents. */
export interface LegacyLifecycleReader {
  listMissions(project: string): Promise<MissionState[]>;
  getMission(project: string, session: string): Promise<MissionState | undefined>;
  listAttempts(project: string, session?: string): Promise<DispatchAttempt[]>;
  listAssignments(project: string): Promise<LegacyAssignment[]>;
  listPendingCompletions(project: string): Promise<LegacyPendingCompletion[]>;
  listReviewReceipts(project: string): Promise<LegacyReviewReceipt[]>;
  getBuildLock(project: string): Promise<LegacyBuildLock | undefined>;
  getCleanupClaim(project: string): Promise<LegacyCleanupClaim | undefined>;
}

export interface LegacyLifecycleStore extends LegacyLifecycleReader {
  setTombstone(project: string, session: string, value: JsonValue): Promise<void>;
}

const isStr = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStrList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isLegacyPendingCompletion(value: unknown): value is LegacyPendingCompletion {
  return (
    isRecord(value) &&
    isStr(value.projectID) &&
    isStr(value.parentSessionID) &&
    isStr(value.missionID) &&
    isStr(value.workerSessionID) &&
    isStr(value.taskID) &&
    isStr(value.epicID) &&
    isStr(value.workerAgentID) &&
    isStr(value.attemptCallID) &&
    isStr(value.dispatchToken) &&
    typeof value.summary === "string" &&
    isStrList(value.filesTouched) &&
    isNum(value.submittedAt)
  );
}

function isLegacyReviewReceipt(value: unknown): value is LegacyReviewReceipt {
  if (!isRecord(value)) return false;
  const approval = value.approval;
  return (
    isStr(value.projectID) &&
    isStr(value.sessionID) &&
    isStr(value.missionID) &&
    isStr(value.taskID) &&
    isStr(value.assignedAgentID) &&
    isStr(value.attemptCallID) &&
    isStr(value.dispatchToken) &&
    isStr(value.diffHash) &&
    isNum(value.reviewedAt) &&
    (approval === undefined || (isRecord(approval) && isStr(approval.diffHash) && isNum(approval.approvedAt)))
  );
}

/** Builds the read-only legacy reader plus the single tombstone write over `ctx.storage`. */
export function createLegacyLifecycleStore(store: LegacyMissionStateStore): LegacyLifecycleStore {
  const scanValues = async (prefix: string): Promise<unknown[]> =>
    (await scanAll(store.storage, prefix)).map((entry) => entry.value);
  return {
    async listMissions(project) {
      const values = await scanValues(`${MISSION_KEY_PREFIX}${project}:`);
      return values
        .filter(isMissionState)
        .filter((mission) => mission.projectID === project)
        .sort((left, right) => left.sessionID.localeCompare(right.sessionID));
    },
    getMission: (project, session) => readMission(store, project, session),
    async listAttempts(project, session) {
      const values = await scanValues(`${ATTEMPT_KEY_PREFIX}${project}:`);
      return values
        .filter(isDispatchAttempt)
        .filter((attempt) => session === undefined || attempt.sessionID === session)
        .sort(compareAttempts);
    },
    async listAssignments(project) {
      const values = await scanValues(`${ASSIGNMENT_KEY_PREFIX}${project}:`);
      const out: LegacyAssignment[] = [];
      for (const value of values) {
        if (!isRecord(value) || !isStr(value.cellID) || !isStr(value.agent) || !isStr(value.updatedAt)) continue;
        if (value.sessionID !== undefined && !isStr(value.sessionID)) continue;
        out.push({
          cellID: value.cellID,
          agent: value.agent,
          updatedAt: value.updatedAt,
          ...(isStr(value.sessionID) ? { sessionID: value.sessionID } : {}),
        });
      }
      return out.sort((left, right) => left.cellID.localeCompare(right.cellID));
    },
    async listPendingCompletions(project) {
      const prefix = `${["pending-completion:", project].map(encodeURIComponent).join(":")}:`;
      return (await scanValues(prefix)).filter(isLegacyPendingCompletion).filter((v) => v.projectID === project);
    },
    async listReviewReceipts(project) {
      const prefix = `${["review-receipt:", project].map(encodeURIComponent).join(":")}:`;
      return (await scanValues(prefix)).filter(isLegacyReviewReceipt).filter((v) => v.projectID === project);
    },
    async getBuildLock(project) {
      const raw = await store.storage.get(buildLockKey(project));
      if (!isRecord(raw) || !isStr(raw.sessionID) || !isStr(raw.callID) || !isStr(raw.acquiredAt)) return undefined;
      if (!Number.isFinite(Date.parse(raw.acquiredAt))) return undefined;
      return {
        projectID: isStr(raw.projectID) ? raw.projectID : project,
        sessionID: raw.sessionID,
        callID: raw.callID,
        command: typeof raw.command === "string" ? raw.command : "",
        acquiredAt: raw.acquiredAt,
      };
    },
    async getCleanupClaim(project) {
      const raw = await store.storage.get(`cleanup-claim:${project}`);
      if (!isRecord(raw) || !isStr(raw.taskID) || !isNum(raw.at)) return undefined;
      return { taskID: raw.taskID, at: raw.at };
    },
    async setTombstone(project, session, value) {
      await store.storage.set(legacyTombstoneKey(project, session), value);
    },
  };
}
