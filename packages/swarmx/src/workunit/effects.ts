import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import type { EffectState, WorkUnitEffect } from "./schema.js";

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
