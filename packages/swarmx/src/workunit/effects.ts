import { createHash, randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import type { EffectState, Mission, WorkUnit, WorkUnitEffect } from "./schema.js";
import { getWorkUnit } from "./store.js";

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

/** Thrown by ports when an external tool definitively rejected the request (no side effect happened). */
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
  receiptHash?: string;
}

export interface WorkUnitEffectPorts {
  readHiveCell(projectKey: string, cellId: string): Promise<HiveCellSnapshot | null>;
  runBackendTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  prepareConsolidation(input: { projectKey: string; epicId: string; unitId: string }): Promise<unknown>;
}

type Outcome = { state: RecordEffectResultInput["state"]; result?: unknown; error?: unknown };

const COMPLETE_TOOL = ["swarm", "complete"].join("_");
const FEEDBACK_TOOL = ["swarm", "review", "feedback"].join("_");

async function getEffect(db: DatabaseAdapter, effectId: string): Promise<WorkUnitEffect | null> {
  const result = await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effectId]);
  return effectFromRow(result.rows[0]);
}

async function getMission(db: DatabaseAdapter, missionPk: string): Promise<Mission | null> {
  const result = await db.query("SELECT * FROM swarmx_missions WHERE id = ?", [missionPk]);
  const row: unknown = result.rows[0];
  return isRecord(row) ? (row as unknown as Mission) : null;
}

function parseRequest(effect: WorkUnitEffect): Record<string, unknown> {
  if (effect.request_json === null || effect.request_json === undefined) return {};
  const parsed: unknown = JSON.parse(effect.request_json);
  return isRecord(parsed) ? parsed : {};
}

function errorPayload(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

function ambiguousOrDefinite(error: unknown): Outcome {
  return error instanceof DefiniteEffectError
    ? { state: "failed_mandatory", error: errorPayload(error) }
    : { state: "unknown", error: errorPayload(error) };
}

/** Verification receipt hash = sha256 hex of the unit's stored verification_receipt_json. */
function receiptHash(unit: WorkUnit): string | null {
  return unit.verification_receipt_json === null
    ? null
    : createHash("sha256").update(unit.verification_receipt_json).digest("hex");
}

function isClosed(cell: HiveCellSnapshot | null): cell is HiveCellSnapshot {
  return cell !== null && cell.status === "closed";
}

function reconcileClosedCell(cell: HiveCellSnapshot, expected: string | null): Outcome {
  if (expected !== null && cell.receiptHash === expected) {
    return { state: "succeeded", result: { status: cell.status, receiptHash: cell.receiptHash } };
  }
  return {
    state: "failed_mandatory",
    error: { message: "Hive cell closed without matching verification receipt", expected, actual: cell.receiptHash ?? null },
  };
}

async function runBackendComplete(unit: WorkUnit, effect: WorkUnitEffect, ports: WorkUnitEffectPorts): Promise<Outcome> {
  const expected = receiptHash(unit);
  const cellId = unit.cell_id ?? "";
  const before = await ports.readHiveCell(unit.project, cellId);
  if (isClosed(before)) return reconcileClosedCell(before, expected);
  try {
    await ports.runBackendTool(COMPLETE_TOOL, parseRequest(effect));
  } catch (error) {
    return ambiguousOrDefinite(error);
  }
  const after = await ports.readHiveCell(unit.project, cellId);
  if (isClosed(after)) return reconcileClosedCell(after, expected);
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
  request: Record<string, unknown>,
  operationId: string,
  ports: WorkUnitEffectPorts,
): Promise<Outcome> {
  try {
    if (effect.kind === "consolidate") {
      const result = await ports.prepareConsolidation({
        projectKey: typeof request.projectKey === "string" ? request.projectKey : unit.project,
        epicId: typeof request.epicId === "string" ? request.epicId : (mission.epic_id ?? ""),
        unitId: typeof request.unitId === "string" ? request.unitId : unit.id,
      });
      return { state: "succeeded", result };
    }
    if (effect.kind.startsWith("followup:")) {
      const result = await ports.runBackendTool("hive_create", { ...request, operation_id: operationId });
      return { state: "succeeded", result: { cellId: cellIdFrom(result) } };
    }
    if (effect.kind === "hive_start") {
      return { state: "succeeded", result: await ports.runBackendTool("hive_start", request) };
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
  const operationId = effect.operation_id ?? effect.effect_id;
  if (effect.kind === "backend_complete") return runBackendComplete(unit, effect, ports);
  if (effect.kind === "backend_feedback") {
    try {
      return { state: "succeeded", result: await ports.runBackendTool(FEEDBACK_TOOL, { ...request, operation_id: operationId }) };
    } catch (error) {
      return ambiguousOrDefinite(error);
    }
  }
  return runOptional(unit, mission, effect, request, operationId, ports);
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
