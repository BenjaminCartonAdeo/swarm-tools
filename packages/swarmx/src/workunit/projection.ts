import type {
  ConsolidationState,
  MissionCellSnapshot,
  MissionState as ProjectedMissionState,
  RetryCauseRecord,
} from "../types.js";
import type { AssignmentRow, MissionBudgetPolicy } from "./mission.js";
import type { Mission, WorkUnit, WorkUnitState } from "./schema.js";

interface ProjectionInput {
  mission: Mission;
  units: WorkUnit[];
  assignments: AssignmentRow[];
}

function parsePolicy(mission: Mission): MissionBudgetPolicy {
  if (mission.budget_policy_json !== null) {
    try {
      const parsed: unknown = JSON.parse(mission.budget_policy_json);
      if (isMissionBudgetPolicy(parsed)) {
        return parsed;
      }
    } catch {
      // Older and partially migrated missions use the persisted budget limit below.
    }
  }
  return { total: mission.budget_limit ?? 0, perCellIterations: 0, workerShare: null, version: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissionBudgetPolicy(value: unknown): value is MissionBudgetPolicy {
  if (!isRecord(value)) return false;
  const workerShare = value.workerShare;
  const validWorkerShare = workerShare === null || (
    isRecord(workerShare)
    && typeof workerShare.agent === "string"
    && workerShare.agent.trim().length > 0
    && typeof workerShare.maxFraction === "number"
    && Number.isFinite(workerShare.maxFraction)
    && workerShare.maxFraction >= 0
    && workerShare.maxFraction <= 1
  );
  return value.version === 1
    && typeof value.total === "number"
    && Number.isFinite(value.total)
    && value.total >= 0
    && typeof value.perCellIterations === "number"
    && Number.isFinite(value.perCellIterations)
    && value.perCellIterations >= 0
    && validWorkerShare;
}

function isRetryCauseRecord(value: unknown): value is RetryCauseRecord {
  if (!isRecord(value)) return false;
  return typeof value.cellID === "string" && value.cellID.length > 0
    && typeof value.epicID === "string" && value.epicID.length > 0
    && typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt > 0
    && typeof value.ts === "string" && value.ts.length > 0
    && (value.failureReason === undefined || typeof value.failureReason === "string")
    && (value.failedCommand === undefined || typeof value.failedCommand === "string")
    && (value.errorExcerpt === undefined || typeof value.errorExcerpt === "string");
}

function isConsolidationStatus(value: unknown): value is ConsolidationState["status"] {
  return value === "pending" || value === "ready" || value === "dispatched" || value === "completed";
}

function parseStoredCauses(mission: Mission): RetryCauseRecord[] {
  if (mission.retry_causes_json === null) return [];
  try {
    const parsed: unknown = JSON.parse(mission.retry_causes_json);
    return Array.isArray(parsed) ? parsed.filter(isRetryCauseRecord) : [];
  } catch {
    return [];
  }
}

function parseConsolidation(mission: Mission): ConsolidationState | undefined {
  if (mission.consolidation_json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(mission.consolidation_json);
    if (!isRecord(parsed)) return undefined;
    const status = parsed.status;
    if (typeof parsed.epicID !== "string" || parsed.epicID.length === 0
      || typeof parsed.cellID !== "string" || parsed.cellID.length === 0
      || !isConsolidationStatus(status) || typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt)
      || (parsed.prompt !== undefined && typeof parsed.prompt !== "string")) {
      return undefined;
    }
    return {
      epicID: parsed.epicID,
      cellID: parsed.cellID,
      status,
      createdAt: parsed.createdAt,
      ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
    };
  } catch {
    return undefined;
  }
}

function isoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function isCharged(unit: WorkUnit): boolean {
  return unit.budget_charge !== null && unit.budget_charge > 0 && unit.cell_id !== null;
}

function retryCauseFromUnit(mission: Mission, unit: WorkUnit): RetryCauseRecord | null {
  if (unit.retry_of === null || unit.cell_id === null) return null;
  return {
    cellID: unit.cell_id,
    epicID: mission.epic_id ?? "",
    attempt: unit.attempt_no,
    ts: isoTimestamp(unit.updated_at),
    ...(unit.reason === null ? {} : { failureReason: unit.reason }),
  };
}

function mergedRetryCauses(mission: Mission, units: readonly WorkUnit[]): RetryCauseRecord[] {
  const causes = new Map<string, RetryCauseRecord>();
  const keyOf = (cause: RetryCauseRecord) => `${cause.cellID}|${cause.attempt}|${cause.ts}`;
  for (const cause of units.flatMap((unit) => {
    const derived = retryCauseFromUnit(mission, unit);
    return derived === null ? [] : [derived];
  })) {
    causes.set(keyOf(cause), cause);
  }
  for (const cause of parseStoredCauses(mission)) causes.set(keyOf(cause), cause);
  return [...causes.values()]
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.cellID.localeCompare(right.cellID))
    .slice(-20);
}

export function projectMission(input: ProjectionInput): ProjectedMissionState {
  const { mission, units } = input;
  const budgetPolicy = parsePolicy(mission);
  const consolidation = parseConsolidation(mission);
  const attemptsByCell: Record<string, number> = {};
  const chargedCells = new Set<string>();
  for (const unit of units) {
    if (!isCharged(unit) || unit.cell_id === null) continue;
    chargedCells.add(unit.cell_id);
    attemptsByCell[unit.cell_id] = (attemptsByCell[unit.cell_id] ?? 0) + 1;
  }
  const createdAt = isoTimestamp(mission.created_at);
  const updatedAt = isoTimestamp(mission.updated_at);
  return {
    missionID: mission.mission_id,
    projectID: mission.project,
    sessionID: mission.session_id,
    active: mission.state === "OPEN" || mission.state === "CLOSING",
    mode: mission.mode ?? "dev",
    budget: {
      maxSpawns: budgetPolicy.total,
      maxIterations: budgetPolicy.perCellIterations,
      ...(budgetPolicy.workerShare === null ? {} : { workerShare: budgetPolicy.workerShare.maxFraction }),
    },
    counts: {
      spawns: units.length,
      cells: chargedCells.size,
      attemptsByCell,
      workerSpawns: units.filter((unit) => unit.worker_agent === "swarm-worker").length,
    },
    retryCauses: mergedRetryCauses(mission, units),
    ...(consolidation === undefined ? {} : { consolidation }),
    createdAt,
    updatedAt,
  };
}

function statusFromUnit(state: WorkUnitState): MissionCellSnapshot["status"] {
  switch (state) {
    case "DONE": return "completed";
    case "FAILED":
    case "REJECTED": return "failed";
    case "CHANGES_REQUESTED":
    case "CANCELLED":
    case "ABANDONED":
    case "REVOKED": return "pending";
    default: return "in_progress";
  }
}

function compareUnitRecency(left: WorkUnit, right: WorkUnit): number {
  return left.updated_at === right.updated_at ? left.id.localeCompare(right.id) : left.updated_at - right.updated_at;
}

export function projectMissionCells(input: ProjectionInput & { cells: MissionCellSnapshot[] }): MissionCellSnapshot[] {
  const { mission, units, assignments, cells } = input;
  const hiveCells = new Map(cells.map((cell) => [cell.id, cell]));
  const assignmentByCell = new Map(assignments
    .filter((assignment) => assignment.project === mission.project
      && assignment.mission_pk === mission.id
      && assignment.state === "assigned"
      && assignment.agent !== null)
    .map((assignment) => [assignment.cell_id, assignment]));
  const unitsByCell = new Map<string, WorkUnit[]>();
  for (const unit of units) {
    if (unit.cell_id === null) continue;
    const bucket = unitsByCell.get(unit.cell_id) ?? [];
    bucket.push(unit);
    unitsByCell.set(unit.cell_id, bucket);
  }
  const counts = projectMission(input).counts.attemptsByCell;
  const ids = new Set([...hiveCells.keys(), ...assignmentByCell.keys(), ...unitsByCell.keys()]);
  const projected = [...ids].map((id): MissionCellSnapshot => {
    const hive = hiveCells.get(id);
    const cellUnits = (unitsByCell.get(id) ?? []).sort(compareUnitRecency);
    const latest = cellUnits.at(-1);
    const assigned = assignmentByCell.get(id);
    return {
      id,
      ...(hive?.title === undefined ? {} : { title: hive.title }),
      ...(hive?.status === undefined && latest === undefined ? {} : { status: hive?.status ?? statusFromUnit(latest?.state ?? "RESERVED") }),
      ...(hive?.agent === undefined && assigned?.agent == null && latest?.worker_agent == null
        ? {}
        : { agent: hive?.agent ?? assigned?.agent ?? latest?.worker_agent ?? undefined }),
      attempts: Math.max(hive?.attempts ?? 0, counts[id] ?? 0, cellUnits.length),
      ...(hive?.dependsOn === undefined ? {} : { dependsOn: hive.dependsOn }),
      ...(hive?.epicID === undefined ? {} : { epicID: hive.epicID }),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return projected;
}

export function selectMissionOrphanCandidates(input: { units: WorkUnit[]; now: number; orphanGraceMs: number }): WorkUnit[] {
  const cutoff = input.now - input.orphanGraceMs;
  return input.units
    .filter((unit) => (unit.state === "RESERVED" || unit.state === "BOUND") && unit.updated_at <= cutoff)
    .sort(compareUnitRecency);
}
