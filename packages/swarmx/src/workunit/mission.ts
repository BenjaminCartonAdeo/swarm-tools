import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import type { ConsolidationState, MissionMode, RetryCauseRecord } from "../types.js";
import type { Mission, WorkUnit } from "./schema.js";
import { getMissionByPk, MissionFenceConflictError } from "./store.js";

export { getMissionByPk };

export interface MissionBudgetPolicy {
  total: number;
  perCellIterations: number;
  workerShare: { agent: string; maxFraction: number } | null;
  version: 1;
}

export interface AssignmentRow {
  project: string;
  cell_id: string;
  owner: string | null;
  raw_json: string;
  created_at: number;
  mission_pk: string | null;
  agent: string | null;
  state: string | null;
  updated_at: number | null;
}

export class MissionConflictError extends Error {
  constructor(project: string, sessionId: string) {
    super(`A live mission already exists for ${project}/${sessionId}`);
    this.name = "MissionConflictError";
  }
}

export class MissionPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionPolicyValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateBudgetPolicy(policy: MissionBudgetPolicy): void {
  if (policy.version !== 1) throw new MissionPolicyValidationError("Unsupported mission budget policy version");
  if (!Number.isFinite(policy.total) || policy.total < 0) {
    throw new MissionPolicyValidationError("Mission budget total must be finite and nonnegative");
  }
  if (!Number.isFinite(policy.perCellIterations) || policy.perCellIterations < 0) {
    throw new MissionPolicyValidationError("Mission per-cell iterations must be finite and nonnegative");
  }
  if (policy.workerShare !== null && (
    policy.workerShare.agent.trim().length === 0
    || !Number.isFinite(policy.workerShare.maxFraction)
    || policy.workerShare.maxFraction < 0
    || policy.workerShare.maxFraction > 1
  )) {
    throw new MissionPolicyValidationError("Mission worker share requires an agent and a fraction from 0 to 1");
  }
}

function asMission(row: unknown): Mission | null {
  return isRecord(row) ? row as unknown as Mission : null;
}

function asAssignment(row: unknown): AssignmentRow | null {
  return isRecord(row) ? row as unknown as AssignmentRow : null;
}

function causeKey(cause: RetryCauseRecord): string {
  return `${cause.cellID}|${cause.attempt}|${cause.ts}`;
}

function sortedCauses(causes: readonly RetryCauseRecord[]): RetryCauseRecord[] {
  return [...causes].sort((left, right) => left.ts.localeCompare(right.ts) || left.cellID.localeCompare(right.cellID))
    .slice(-20);
}

export async function createMission(
  db: DatabaseAdapter,
  input: {
    project: string;
    sessionId: string;
    missionId?: string;
    epicId?: string | null;
    mode: MissionMode;
    budgetPolicy: MissionBudgetPolicy;
    consolidation?: ConsolidationState | null;
    retryCauses?: RetryCauseRecord[];
    now?: number;
  },
): Promise<Mission> {
  validateBudgetPolicy(input.budgetPolicy);
  const missionId = input.missionId ?? randomUUID();
  const id = `mission:${input.project}:${input.sessionId}:${missionId}`;
  const now = input.now ?? Date.now();
  try {
    const result = await db.query(
      `INSERT INTO swarmx_missions
        (id, project, session_id, mission_id, epic_id, state, fence, budget_limit, mode,
         budget_policy_json, consolidation_json, retry_causes_json, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'OPEN', 0, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM swarmx_missions WHERE project = ? AND session_id = ? AND state IN ('OPEN', 'CLOSING')
       )
       RETURNING *`,
      [
        id, input.project, input.sessionId, missionId, input.epicId ?? null, input.budgetPolicy.total,
        input.mode, JSON.stringify(input.budgetPolicy), input.consolidation == null ? null : JSON.stringify(input.consolidation),
        input.retryCauses === undefined ? null : JSON.stringify(sortedCauses(input.retryCauses)), now, now,
        input.project, input.sessionId,
      ],
    );
    const mission = asMission(result.rows[0]);
    if (mission !== null) return mission;
  } catch (error) {
    const live = await db.query(
      "SELECT id FROM swarmx_missions WHERE project = ? AND session_id = ? AND state IN ('OPEN', 'CLOSING') LIMIT 1",
      [input.project, input.sessionId],
    );
    if (live.rows.length > 0) throw new MissionConflictError(input.project, input.sessionId);
    throw error;
  }
  throw new MissionConflictError(input.project, input.sessionId);
}

export async function getMission(db: DatabaseAdapter, project: string, session: string): Promise<Mission | null> {
  const result = await db.query(
    `SELECT * FROM swarmx_missions WHERE project = ? AND session_id = ?
     ORDER BY CASE WHEN state IN ('OPEN', 'CLOSING') THEN 0 ELSE 1 END,
       created_at DESC, updated_at DESC, id DESC LIMIT 1`,
    [project, session],
  );
  return asMission(result.rows[0]);
}

export async function listMissions(db: DatabaseAdapter, project: string, session?: string): Promise<Mission[]> {
  const result = session === undefined
    ? await db.query("SELECT * FROM swarmx_missions WHERE project = ? ORDER BY created_at DESC, id DESC", [project])
    : await db.query("SELECT * FROM swarmx_missions WHERE project = ? AND session_id = ? ORDER BY created_at DESC, id DESC", [project, session]);
  return result.rows.flatMap((row) => {
    const mission = asMission(row);
    return mission === null ? [] : [mission];
  });
}

async function updateMission(
  db: DatabaseAdapter,
  input: { missionPk: string; expectedFence: number; now?: number },
  setClause: string,
  values: readonly unknown[],
): Promise<Mission> {
  const result = await db.query(
    `UPDATE swarmx_missions SET ${setClause}, fence = fence + 1, updated_at = ? WHERE id = ? AND fence = ? RETURNING *`,
    [...values, input.now ?? Date.now(), input.missionPk, input.expectedFence],
  );
  const mission = asMission(result.rows[0]);
  if (mission === null) throw new MissionFenceConflictError(input.missionPk, input.expectedFence);
  return mission;
}

export async function updateMissionPolicy(
  db: DatabaseAdapter,
  input: { missionPk: string; expectedFence: number; budgetPolicy: MissionBudgetPolicy; now?: number },
): Promise<Mission> {
  validateBudgetPolicy(input.budgetPolicy);
  return updateMission(db, input, "budget_policy_json = ?, budget_limit = ?", [JSON.stringify(input.budgetPolicy), input.budgetPolicy.total]);
}

export async function setConsolidation(
  db: DatabaseAdapter,
  input: { missionPk: string; expectedFence: number; consolidation: ConsolidationState | null; now?: number },
): Promise<Mission> {
  return updateMission(db, input, "consolidation_json = ?", [input.consolidation === null ? null : JSON.stringify(input.consolidation)]);
}

export async function recordRetryCause(
  db: DatabaseAdapter,
  input: { missionPk: string; expectedFence: number; cause: RetryCauseRecord; now?: number },
): Promise<Mission> {
  const current = await getMissionByPk(db, input.missionPk);
  if (current === null || Number(current.fence) !== input.expectedFence) {
    throw new MissionFenceConflictError(input.missionPk, input.expectedFence);
  }
  let existing: RetryCauseRecord[] = [];
  if (current.retry_causes_json !== null) {
    try {
      const parsed: unknown = JSON.parse(current.retry_causes_json);
      if (Array.isArray(parsed)) existing = parsed as RetryCauseRecord[];
    } catch {
      existing = [];
    }
  }
  const byKey = new Map<string, RetryCauseRecord>(existing.map((cause) => [causeKey(cause), cause]));
  if (!byKey.has(causeKey(input.cause))) byKey.set(causeKey(input.cause), input.cause);
  return updateMission(db, input, "retry_causes_json = ?", [JSON.stringify(sortedCauses([...byKey.values()]))]);
}

export async function assignCell(
  db: DatabaseAdapter,
  input: { project: string; cellId: string; missionPk: string; agent: string; ownerSessionId: string; now?: number },
): Promise<AssignmentRow> {
  const now = input.now ?? Date.now();
  const rawJson = JSON.stringify({ ownerSessionId: input.ownerSessionId, agent: input.agent });
  const result = await db.query(
    `INSERT INTO swarmx_legacy_assignments
       (project, cell_id, owner, raw_json, created_at, mission_pk, agent, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?)
     ON CONFLICT (project, cell_id) DO UPDATE SET
       owner = excluded.owner, raw_json = excluded.raw_json, mission_pk = excluded.mission_pk,
       agent = excluded.agent, state = 'assigned', updated_at = excluded.updated_at
     RETURNING *`,
    [input.project, input.cellId, input.ownerSessionId, rawJson, now, input.missionPk, input.agent, now],
  );
  const row = asAssignment(result.rows[0]);
  if (row === null) throw new Error("Assignment upsert returned no row");
  return row;
}

export async function releaseAssignment(
  db: DatabaseAdapter,
  input: { project: string; cellId: string; now?: number },
): Promise<AssignmentRow | null> {
  const result = await db.query(
    `UPDATE swarmx_legacy_assignments SET owner = NULL, agent = NULL, state = 'released', updated_at = ?
     WHERE project = ? AND cell_id = ? RETURNING *`,
    [input.now ?? Date.now(), input.project, input.cellId],
  );
  return asAssignment(result.rows[0]);
}

export async function listUnits(db: DatabaseAdapter, missionPk: string): Promise<WorkUnit[]> {
  const result = await db.query("SELECT * FROM swarmx_work_units WHERE mission_pk = ? ORDER BY created_at, id", [missionPk]);
  return result.rows.flatMap((row) => isRecord(row) ? [row as unknown as WorkUnit] : []);
}
