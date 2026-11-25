import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import type { EffectState, Mission, WorkUnit, WorkUnitEffect } from "./schema.js";
import {
  finishMissionClose,
  getWorkUnit,
  LIVE_WORK_UNIT_STATES_SQL,
  MissionFenceConflictError,
  type MissionCloseFence,
} from "./store.js";

export class ForcedCloseNotAllowedError extends Error {
  constructor(missionId: string) {
    super(`Mission ${missionId} has live WorkUnits without failed_mandatory evidence`);
    this.name = "ForcedCloseNotAllowedError";
  }
}

/** Guard shared by every forced-close statement: mission fenced/owned/CLOSING and every live unit is evidenced. */
const FORCE_GUARD_SQL = `EXISTS (SELECT 1 FROM swarmx_missions m WHERE m.id = ? AND m.session_id = ? AND m.fence = ? AND m.state = 'CLOSING')
  AND NOT EXISTS (SELECT 1 FROM swarmx_work_units lu WHERE lu.mission_pk = ? AND lu.state IN ${LIVE_WORK_UNIT_STATES_SQL}
    AND NOT (lu.state IN ('PUBLISHING', 'RETURNING') AND EXISTS (
      SELECT 1 FROM swarmx_effects fe WHERE fe.unit_id = lu.id AND fe.state = 'failed_mandatory')))`;

/**
 * Coordinator forced close: (1) orphan unfinished effects and clear claim tokens, (2) fail evidenced units,
 * (3) run the barrier. Each statement is fenced and idempotent, so a crash between steps is recoverable by retrying.
 */
export async function forceMissionClose(db: DatabaseAdapter, input: MissionCloseFence): Promise<Mission> {
  const guard = [input.missionId, input.ownerSessionId, input.expectedFence, input.missionId];
  const mission = await getMission(db, input.missionId);
  if (mission === null || mission.session_id !== input.ownerSessionId) {
    throw new MissionFenceConflictError(input.missionId, input.expectedFence);
  }
  if (mission.state === "CLOSING" && Number(mission.fence) === input.expectedFence) {
    const evidence = await db.query(`SELECT 1 AS ok WHERE ${FORCE_GUARD_SQL}`, guard);
    if (evidence.rows.length === 0) throw new ForcedCloseNotAllowedError(input.missionId);
    const now = Date.now();
    await db.query(
      `UPDATE swarmx_effects
       SET state = 'orphaned', claim_token = NULL, host_instance_id = NULL, claimed_hostname = NULL,
           claimed_by_pid = NULL, claimed_at = NULL, updated_at = ?
       WHERE state IN ('pending', 'in_flight', 'unknown')
         AND unit_id IN (SELECT id FROM swarmx_work_units WHERE mission_pk = ? AND state IN ('PUBLISHING', 'RETURNING'))
         AND ${FORCE_GUARD_SQL}`,
      [now, input.missionId, ...guard],
    );
    await db.query(
      `UPDATE swarmx_work_units
       SET state = 'FAILED', fence = fence + 1, reason = COALESCE(reason, 'mission_forced_close'),
           error_json = COALESCE(error_json, '{"cause":"failed_mandatory_effect"}'), updated_at = ?
       WHERE mission_pk = ? AND state IN ('PUBLISHING', 'RETURNING') AND ${FORCE_GUARD_SQL}`,
      [now, input.missionId, ...guard],
    );
  }
  return finishMissionClose(db, input);
}

export class EffectNotFoundError extends Error {
  constructor(effectId: string) {
    super(`WorkUnit effect ${effectId} was not found`);
    this.name = "EffectNotFoundError";
  }
}

export class EffectClaimConflictError extends Error {
  constructor(effectId: string) {
    super(`WorkUnit effect ${effectId} is not owned by the current claim`);
    this.name = "EffectClaimConflictError";
  }
}

export interface ClaimEffectInput {
  effectId: string;
  unitId: string;
  expectedUnitState: "PUBLISHING" | "RETURNING";
  unitFence: number;
  hostInstanceId: string;
  hostname: string;
  pid: number;
}

export interface RecordEffectResultInput {
  effectId: string;
  claimToken: string;
  state: Extract<EffectState, "succeeded" | "unknown" | "failed_optional" | "failed_mandatory" | "orphaned">;
  result?: unknown;
  error?: unknown;
}

export interface RecoverStaleEffectsInput {
  hostInstanceId: string;
  hostname: string;
  isProcessAlive: (pid: number) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function effectFromRow(value: unknown): WorkUnitEffect | null {
  return isRecord(value) ? (value as unknown as WorkUnitEffect) : null;
}

function serialize(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : serialized;
}

export async function claimEffect(
  db: DatabaseAdapter,
  input: ClaimEffectInput,
): Promise<{ claimToken: string; effect: WorkUnitEffect } | null> {
  const claimToken = randomUUID();
  const claimedAt = Date.now();
  const result = await db.query(
    `UPDATE swarmx_effects
     SET state = 'in_flight', attempt = attempt + 1, claim_token = ?, host_instance_id = ?,
         claimed_hostname = ?, claimed_by_pid = ?, claimed_at = ?, result_json = NULL,
         error_json = NULL, updated_at = ?
     WHERE effect_id = ? AND unit_id = ? AND unit_fence = ? AND state IN ('pending', 'unknown')
       AND EXISTS (
         SELECT 1 FROM swarmx_work_units
         WHERE swarmx_work_units.id = swarmx_effects.unit_id
           AND swarmx_work_units.state = ? AND swarmx_work_units.fence = ?
       )
     RETURNING *`,
    [
      claimToken,
      input.hostInstanceId,
      input.hostname,
      input.pid,
      claimedAt,
      claimedAt,
      input.effectId,
      input.unitId,
      input.unitFence,
      input.expectedUnitState,
      input.unitFence,
    ],
  );
  const effect = effectFromRow(result.rows[0]);
  return effect === null ? null : { claimToken, effect };
}

export async function recordEffectResult(
  db: DatabaseAdapter,
  input: RecordEffectResultInput,
): Promise<WorkUnitEffect> {
  const now = Date.now();
  const result = await db.query(
    `UPDATE swarmx_effects
     SET state = ?, result_json = ?, error_json = ?, claim_token = NULL, host_instance_id = NULL,
         claimed_hostname = NULL, claimed_by_pid = NULL, claimed_at = NULL, updated_at = ?
     WHERE effect_id = ? AND state = 'in_flight' AND claim_token = ?
     RETURNING *`,
    [input.state, serialize(input.result), serialize(input.error), now, input.effectId, input.claimToken],
  );
  const effect = effectFromRow(result.rows[0]);
  if (effect !== null) return effect;

  const existing = await db.query("SELECT effect_id FROM swarmx_effects WHERE effect_id = ?", [input.effectId]);
  if (!isRecord(existing.rows[0])) throw new EffectNotFoundError(input.effectId);
  throw new EffectClaimConflictError(input.effectId);
}

export async function recoverStaleEffects(
  db: DatabaseAdapter,
  input: RecoverStaleEffectsInput,
): Promise<{ recovered: number; foreignHostCandidates: string[] }> {
  const result = await db.query(
    `SELECT effect_id, claim_token, claimed_by_pid, host_instance_id, claimed_hostname
     FROM swarmx_effects WHERE state = 'in_flight' ORDER BY effect_id`,
  );
  let recovered = 0;
  const foreignHostCandidates: string[] = [];

  for (const candidate of result.rows) {
    if (!isRecord(candidate) || typeof candidate.effect_id !== "string") continue;
    const effectId = candidate.effect_id;
    const sameHost = candidate.host_instance_id === input.hostInstanceId
      && candidate.claimed_hostname === input.hostname;
    if (!sameHost) {
      foreignHostCandidates.push(effectId);
      continue;
    }

    const pid = candidate.claimed_by_pid;
    const claimToken = candidate.claim_token;
    if (typeof pid !== "number" || typeof claimToken !== "string" || input.isProcessAlive(pid)) continue;

    const recovery = await db.query(
      `UPDATE swarmx_effects
       SET state = 'unknown', claim_token = NULL, host_instance_id = NULL, claimed_hostname = NULL,
           claimed_by_pid = NULL, claimed_at = NULL, updated_at = ?
       WHERE effect_id = ? AND state = 'in_flight' AND claim_token = ?
         AND host_instance_id = ? AND claimed_hostname = ? AND claimed_by_pid = ?
       RETURNING effect_id`,
      [Date.now(), effectId, claimToken, input.hostInstanceId, input.hostname, pid],
    );
    if (recovery.rows.length > 0) recovered += 1;
  }

  return { recovered, foreignHostCandidates };
}

/**
 * Port error contract: a port MUST throw `DefiniteEffectError` when the external
 * tool definitively rejected the request (no side effect happened or can happen).
 * Any other thrown value is treated as ambiguous: the side effect may or may not
 * have happened, so mandatory effects are recorded as `unknown` and reconciled
 * on the next run. A port that resolves (does not throw) signals acceptance.
 */
export class DefiniteEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteEffectError";
  }
}

export interface EffectHostIdentity {
  hostInstanceId: string;
  hostname: string;
  pid: number;
}

export interface HiveCellSnapshot {
  status: string;
  operationId?: string;
  result?: unknown;
  /** Hive `completion_operation_id` persisted when the cell was closed idempotently. */
  completionOperationId?: string | null;
}

/** External ports used by the effect runner. See `DefiniteEffectError` for the error contract. */
export interface WorkUnitEffectPorts {
  /** Returns null when the cell does not exist. */
  readHiveCell(projectKey: string, cellId: string): Promise<HiveCellSnapshot | null>;
  runBackendTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  prepareConsolidation(input: { projectKey: string; epicId: string; unitId: string }): Promise<unknown>;
}

type Outcome = { state: RecordEffectResultInput["state"]; result?: unknown; error?: unknown };

const SWARM_COMPLETE_TOOL = "swarm_complete";
const SWARM_REVIEW_FEEDBACK_TOOL = "swarm_review_feedback";
const HIVE_CREATE_TOOL = "hive_create";
const HIVE_START_TOOL = "hive_start";

async function getEffect(db: DatabaseAdapter, effectId: string): Promise<WorkUnitEffect | null> {
  const result = await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effectId]);
  return effectFromRow(result.rows[0]);
}

async function getMission(db: DatabaseAdapter, missionPk: string): Promise<Mission | null> {
  const result = await db.query("SELECT * FROM swarmx_missions WHERE id = ?", [missionPk]);
  const row: unknown = result.rows[0];
  return isRecord(row) ? (row as unknown as Mission) : null;
}

/** Returns the stored request object, or null when missing, malformed, or not a JSON object. */
function parseRequest(effect: WorkUnitEffect): Record<string, unknown> | null {
  if (typeof effect.request_json !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(effect.request_json);
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function errorPayload(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

function ambiguousOrDefinite(error: unknown): Outcome {
  return error instanceof DefiniteEffectError
    ? { state: "failed_mandatory", error: errorPayload(error) }
    : { state: "unknown", error: errorPayload(error) };
}

function isClosed(cell: HiveCellSnapshot | null): cell is HiveCellSnapshot {
  return cell !== null && cell.status === "closed";
}

function reconcileClosedCell(cell: HiveCellSnapshot, operationId: string): Outcome {
  if (cell.completionOperationId === operationId) {
    return { state: "succeeded", result: { status: cell.status, completionOperationId: operationId } };
  }
  return {
    state: "failed_mandatory",
    error: {
      message: "Hive cell closed without matching completion identity",
      expected: operationId,
      actual: cell.completionOperationId ?? null,
    },
  };
}

async function runBackendComplete(
  unit: WorkUnit,
  request: Record<string, unknown>,
  operationId: string,
  ports: WorkUnitEffectPorts,
): Promise<Outcome> {
  if (typeof unit.cell_id !== "string" || unit.cell_id.length === 0) {
    return { state: "failed_mandatory", error: { message: "WorkUnit has no cell_id to complete" } };
  }
  const before = await ports.readHiveCell(unit.project, unit.cell_id);
  if (isClosed(before)) return reconcileClosedCell(before, operationId);
  try {
    await ports.runBackendTool(SWARM_COMPLETE_TOOL, { ...request, operation_id: operationId });
  } catch (error) {
    return ambiguousOrDefinite(error);
  }
  const after = await ports.readHiveCell(unit.project, unit.cell_id);
  if (isClosed(after)) return reconcileClosedCell(after, operationId);
  return { state: "unknown", error: { message: "Hive cell not closed after completion" } };
}

function cellIdFrom(result: unknown): string | null {
  if (!isRecord(result)) return typeof result === "string" ? result : null;
  for (const key of ["id", "cell_id", "cellId"]) {
    const value = result[key];
    if (typeof value === "string") return value;
  }
  return null;
}

async function runOptional(
  unit: WorkUnit,
  mission: Mission,
  effect: WorkUnitEffect,
  request: Record<string, unknown> | null,
  operationId: string,
  ports: WorkUnitEffectPorts,
): Promise<Outcome> {
  try {
    if (effect.kind === "consolidate") {
      const stored = request ?? {};
      const epicId = typeof stored.epicId === "string" && stored.epicId.length > 0 ? stored.epicId : mission.epic_id;
      if (typeof epicId !== "string" || epicId.length === 0) {
        return { state: "failed_optional", error: { message: "No mission epic_id to consolidate" } };
      }
      const result = await ports.prepareConsolidation({
        projectKey: typeof stored.projectKey === "string" ? stored.projectKey : unit.project,
        epicId,
        unitId: typeof stored.unitId === "string" ? stored.unitId : unit.id,
      });
      return { state: "succeeded", result };
    }
    if (request === null) {
      return { state: "failed_optional", error: { message: "Missing or malformed request_json" } };
    }
    if (effect.kind.startsWith("followup:")) {
      const result = await ports.runBackendTool(HIVE_CREATE_TOOL, { ...request, operation_id: operationId });
      return { state: "succeeded", result: { cellId: cellIdFrom(result) } };
    }
    if (effect.kind === "hive_start") {
      return { state: "succeeded", result: await ports.runBackendTool(HIVE_START_TOOL, request) };
    }
    return { state: "failed_optional", error: { message: `Unknown effect kind ${effect.kind}` } };
  } catch (error) {
    return { state: "failed_optional", error: errorPayload(error) };
  }
}

async function executeEffect(
  unit: WorkUnit,
  mission: Mission,
  effect: WorkUnitEffect,
  ports: WorkUnitEffectPorts,
): Promise<Outcome> {
  const request = parseRequest(effect);
  const isMandatoryKind = effect.kind === "backend_complete" || effect.kind === "backend_feedback";
  if (!isMandatoryKind) {
    return runOptional(unit, mission, effect, request, effect.operation_id ?? effect.effect_id, ports);
  }
  // Mandatory effects never call out with an empty/guessed request or identity.
  if (request === null) {
    return { state: "failed_mandatory", error: { message: "Missing or malformed request_json" } };
  }
  if (typeof effect.operation_id !== "string" || effect.operation_id.length === 0) {
    return { state: "failed_mandatory", error: { message: "Mandatory effect has no operation_id" } };
  }
  if (effect.kind === "backend_complete") return runBackendComplete(unit, request, effect.operation_id, ports);
  try {
    const result = await ports.runBackendTool(SWARM_REVIEW_FEEDBACK_TOOL, { ...request, operation_id: effect.operation_id });
    return { state: "succeeded", result };
  } catch (error) {
    return ambiguousOrDefinite(error);
  }
}

async function orphanEffect(db: DatabaseAdapter, effect: WorkUnitEffect): Promise<WorkUnitEffect> {
  const result = await db.query(
    `UPDATE swarmx_effects SET state = 'orphaned', updated_at = ?
     WHERE effect_id = ? AND state IN ('pending', 'unknown') RETURNING *`,
    [Date.now(), effect.effect_id],
  );
  return effectFromRow(result.rows[0]) ?? (await getEffect(db, effect.effect_id)) ?? effect;
}

export async function runWorkUnitEffect(
  db: DatabaseAdapter,
  input: { effectId: string; host: EffectHostIdentity; ports: WorkUnitEffectPorts },
): Promise<WorkUnitEffect> {
  const effect = await getEffect(db, input.effectId);
  if (effect === null) throw new EffectNotFoundError(input.effectId);
  const unit = await getWorkUnit(db, effect.unit_id);
  const mission = unit === null ? null : await getMission(db, unit.mission_pk);
  const expectedUnitState = effect.kind === "backend_feedback" ? "RETURNING" : "PUBLISHING";
  if (unit === null || mission === null || unit.state !== expectedUnitState || unit.fence !== effect.unit_fence) {
    return orphanEffect(db, effect);
  }

  const claim = await claimEffect(db, {
    effectId: effect.effect_id,
    unitId: unit.id,
    expectedUnitState,
    unitFence: unit.fence,
    hostInstanceId: input.host.hostInstanceId,
    hostname: input.host.hostname,
    pid: input.host.pid,
  });
  if (claim === null) return (await getEffect(db, effect.effect_id)) ?? effect;

  const outcome = await executeEffect(unit, mission, claim.effect, input.ports);
  return recordEffectResult(db, { effectId: effect.effect_id, claimToken: claim.claimToken, ...outcome });
}

function optionalRank(kind: string): [number, number] {
  if (kind === "consolidate") return [0, 0];
  if (kind.startsWith("followup:")) return [1, Number(kind.slice("followup:".length))];
  if (kind === "hive_start") return [2, 0];
  return [3, 0];
}

async function listEffects(db: DatabaseAdapter, unitId: string): Promise<WorkUnitEffect[]> {
  const result = await db.query("SELECT * FROM swarmx_effects WHERE unit_id = ? ORDER BY effect_id", [unitId]);
  return result.rows.map(effectFromRow).filter((effect): effect is WorkUnitEffect => effect !== null);
}

export async function drainWorkUnitEffects(
  db: DatabaseAdapter,
  input: { unitId: string; host: EffectHostIdentity; ports: WorkUnitEffectPorts },
): Promise<{ unit: WorkUnit; effects: WorkUnitEffect[] }> {
  const unit = await getWorkUnit(db, input.unitId);
  if (unit === null) throw new Error(`WorkUnit ${input.unitId} was not found`);
  const mission = await getMission(db, unit.mission_pk);
  if (mission === null) throw new Error(`Mission ${unit.mission_pk} was not found`);

  const effects = await listEffects(db, unit.id);
  const mandatory = effects.filter((effect) => Boolean(effect.mandatory)).sort((a, b) => a.kind.localeCompare(b.kind));
  const optional = effects
    .filter((effect) => !effect.mandatory)
    .sort((a, b) => {
      const [ra, na] = optionalRank(a.kind);
      const [rb, nb] = optionalRank(b.kind);
      return ra - rb || na - nb;
    });

  let mandatoryOk = true;
  for (const effect of mandatory) {
    const ran = await runWorkUnitEffect(db, { effectId: effect.effect_id, host: input.host, ports: input.ports });
    if (ran.state !== "succeeded") {
      mandatoryOk = false;
      break;
    }
  }
  if (mandatoryOk) {
    for (const effect of optional) {
      await runWorkUnitEffect(db, { effectId: effect.effect_id, host: input.host, ports: input.ports });
    }
  }

  return { unit: (await getWorkUnit(db, unit.id)) ?? unit, effects: await listEffects(db, unit.id) };
}
