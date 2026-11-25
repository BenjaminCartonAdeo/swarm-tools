/**
 * Review Feedback Operations Store
 *
 * Durable, operation-keyed claim/result records for `swarm_review_feedback`.
 * State machine: claimed → in_progress → done. The attempt number is
 * allocated atomically (single INSERT … SELECT) per (project_key, task_id) and
 * persisted, so it survives process restarts and replays.
 *
 * `operation_id` is the authoritative unit binding; `unit_id` is metadata.
 * No lease or timer: abandoned claims are recovered only with evidence
 * (same host + dead PID) or by explicit operator recovery.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "../types/database.js";
import { OperationIdConflictError } from "../operation-id-conflict.js";
import { getSwarmMailDatabaseAdapter } from "./store.js";

/** Success payload of swarm_review_feedback plus replay marker. */
export type ReviewFeedbackResult = Record<string, unknown> & {
  success: true;
  status: "approved" | "needs_changes";
  task_id: string;
  duplicate?: boolean;
};

export interface ClaimReviewFeedbackInput {
  operationId: string;
  projectKey: string;
  unitId?: string;
  taskId: string;
  workerId: string;
  requestHash: string;
  status: "approved" | "needs_changes";
  hostInstanceId: string;
  hostname: string;
  pid: number;
}

export type ClaimReviewFeedbackOutcome =
  | { kind: "claimed"; claimToken: string; attempt: number }
  | { kind: "busy"; attempt: number }
  | { kind: "done"; result: ReviewFeedbackResult };

export class StaleReviewFeedbackClaimError extends Error {
  constructor(operationId: string) {
    super(`[review-feedback] stale or unknown claim token for operation ${operationId}`);
    this.name = "StaleReviewFeedbackClaimError";
  }
}

interface OperationRow {
  operation_id: string;
  request_hash: string;
  attempt: number;
  state: "claimed" | "in_progress" | "done";
  claim_token: string | null;
  hostname: string | null;
  pid: number | null;
  result: string | null;
}

function resolveDb(db?: DatabaseAdapter): Promise<DatabaseAdapter> {
  return db ? Promise.resolve(db) : getSwarmMailDatabaseAdapter();
}

async function loadOperation(db: DatabaseAdapter, operationId: string): Promise<OperationRow | null> {
  const found = await db.query<OperationRow>(
    `SELECT operation_id, request_hash, attempt, state, claim_token, hostname, pid, result
     FROM review_feedback_operations WHERE operation_id = ?`,
    [operationId],
  );
  return found.rows[0] ?? null;
}

/**
 * Claim an operation. Allocates the attempt exactly once per operation_id.
 * A concurrent duplicate gets `busy` (never the owner's token); a finished
 * operation returns its saved result.
 */
export async function claimReviewFeedback(
  input: ClaimReviewFeedbackInput,
  dbOverride?: DatabaseAdapter,
): Promise<ClaimReviewFeedbackOutcome> {
  const db = await resolveDb(dbOverride);
  const claimToken = randomUUID();
  const now = Date.now();

  // Atomic allocation: the attempt is derived and the row inserted in one
  // statement; ON CONFLICT makes losers no-ops. `WHERE 1` disambiguates the
  // SQLite INSERT … SELECT … ON CONFLICT grammar.
  await db.query(
    `INSERT INTO review_feedback_operations (
       operation_id, project_key, unit_id, task_id, worker_id, status, request_hash,
       attempt, state, claim_token, host_instance_id, hostname, pid, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?,
       MAX(1, (SELECT COUNT(*) FROM review_feedback_operations
               WHERE project_key = ? AND task_id = ? AND status = 'needs_changes')
              + CASE WHEN ? = 'needs_changes' THEN 1 ELSE 0 END),
       'claimed', ?, ?, ?, ?, ?, ?
     WHERE 1
     ON CONFLICT(operation_id) DO NOTHING`,
    [
      input.operationId,
      input.projectKey,
      input.unitId ?? null,
      input.taskId,
      input.workerId,
      input.status,
      input.requestHash,
      input.projectKey,
      input.taskId,
      input.status,
      claimToken,
      input.hostInstanceId,
      input.hostname,
      input.pid,
      now,
      now,
    ],
  );

  const row = await loadOperation(db, input.operationId);
  if (!row) throw new Error(`[review-feedback] claim row missing for ${input.operationId}`);
  if (row.request_hash !== input.requestHash) {
    throw new OperationIdConflictError(input.operationId, undefined, "review_feedback_operations");
  }
  if (row.claim_token === claimToken) {
    return { kind: "claimed", claimToken, attempt: Number(row.attempt) };
  }
  if (row.state === "done") {
    return { kind: "done", result: JSON.parse(row.result ?? "null") as ReviewFeedbackResult };
  }
  if (row.claim_token === null) {
    // Recovered claim: take it over atomically, keeping the persisted attempt.
    const taken = await db.query<{ attempt: number }>(
      `UPDATE review_feedback_operations
       SET claim_token = ?, state = 'claimed', host_instance_id = ?, hostname = ?, pid = ?, updated_at = ?
       WHERE operation_id = ? AND claim_token IS NULL AND state != 'done'
       RETURNING attempt`,
      [claimToken, input.hostInstanceId, input.hostname, input.pid, Date.now(), input.operationId],
    );
    const attempt = taken.rows[0]?.attempt;
    if (attempt !== undefined) return { kind: "claimed", claimToken, attempt: Number(attempt) };
    const latest = await loadOperation(db, input.operationId);
    if (latest?.state === "done") {
      return { kind: "done", result: JSON.parse(latest.result ?? "null") as ReviewFeedbackResult };
    }
  }
  return { kind: "busy", attempt: Number(row.attempt) };
}

/** claimed → in_progress; rejects stale tokens. */
export async function markReviewFeedbackStarted(
  operationId: string,
  claimToken: string,
  dbOverride?: DatabaseAdapter,
): Promise<void> {
  const db = await resolveDb(dbOverride);
  const updated = await db.query(
    `UPDATE review_feedback_operations SET state = 'in_progress', updated_at = ?
     WHERE operation_id = ? AND claim_token = ? AND state IN ('claimed', 'in_progress')
     RETURNING operation_id`,
    [Date.now(), operationId, claimToken],
  );
  if (updated.rows.length === 0) throw new StaleReviewFeedbackClaimError(operationId);
}

/** → done with the saved result; rejects stale tokens and double completion. */
export async function completeReviewFeedback(
  operationId: string,
  claimToken: string,
  result: ReviewFeedbackResult,
  dbOverride?: DatabaseAdapter,
): Promise<void> {
  const db = await resolveDb(dbOverride);
  const updated = await db.query(
    `UPDATE review_feedback_operations
     SET state = 'done', result = ?, claim_token = NULL, updated_at = ?
     WHERE operation_id = ? AND claim_token = ? AND state IN ('claimed', 'in_progress')
     RETURNING operation_id`,
    [JSON.stringify(result), Date.now(), operationId, claimToken],
  );
  if (updated.rows.length === 0) throw new StaleReviewFeedbackClaimError(operationId);
}

/**
 * Release unfinished claims whose owner is provably dead: same hostname and
 * `isProcessAlive(pid)` false. Foreign-host claims are only reported.
 */
export async function recoverStaleReviewFeedback(
  input: { hostname: string; isProcessAlive: (pid: number) => boolean },
  dbOverride?: DatabaseAdapter,
): Promise<{ recovered: number; foreignCandidates: string[] }> {
  const db = await resolveDb(dbOverride);
  const open = await db.query<OperationRow>(
    `SELECT operation_id, request_hash, attempt, state, claim_token, hostname, pid, result
     FROM review_feedback_operations
     WHERE state != 'done' AND claim_token IS NOT NULL
     ORDER BY operation_id`,
  );
  let recovered = 0;
  const foreignCandidates: string[] = [];
  for (const row of open.rows) {
    if (row.hostname !== input.hostname) {
      foreignCandidates.push(row.operation_id);
      continue;
    }
    if (row.pid === null || input.isProcessAlive(Number(row.pid))) continue;
    const released = await db.query(
      `UPDATE review_feedback_operations SET claim_token = NULL, updated_at = ?
       WHERE operation_id = ? AND claim_token = ? AND state != 'done'
       RETURNING operation_id`,
      [Date.now(), row.operation_id, row.claim_token],
    );
    recovered += released.rows.length;
  }
  return { recovered, foreignCandidates };
}

/**
 * Owner-initiated release after a failed side effect: clears the token while
 * preserving state and attempt, so a retry (same or other process) can
 * re-claim. Side effects are operation-keyed, so re-execution is safe.
 */
export async function releaseReviewFeedbackClaim(
  operationId: string,
  claimToken: string,
  dbOverride?: DatabaseAdapter,
): Promise<void> {
  const db = await resolveDb(dbOverride);
  const released = await db.query(
    `UPDATE review_feedback_operations SET claim_token = NULL, updated_at = ?
     WHERE operation_id = ? AND claim_token = ? AND state != 'done'
     RETURNING operation_id`,
    [Date.now(), operationId, claimToken],
  );
  if (released.rows.length === 0) throw new StaleReviewFeedbackClaimError(operationId);
}

/**
 * Durable review gate: true when the latest completed keyed feedback for
 * (projectKey, taskId) approved the task.
 */
export async function getDurableReviewApproval(
  projectKey: string,
  taskId: string,
  dbOverride?: DatabaseAdapter,
): Promise<boolean> {
  const db = await resolveDb(dbOverride);
  const latest = await db.query<{ result: string | null }>(
    `SELECT result FROM review_feedback_operations
     WHERE project_key = ? AND task_id = ? AND state = 'done'
     ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    [projectKey, taskId],
  );
  const raw = latest.rows[0]?.result;
  if (!raw) return false;
  return (JSON.parse(raw) as { status?: string }).status === "approved";
}

/** Explicit operator recovery of one unfinished claim (e.g. foreign host). */
export async function recoverReviewFeedbackOperation(
  operationId: string,
  dbOverride?: DatabaseAdapter,
): Promise<boolean> {
  const db = await resolveDb(dbOverride);
  const released = await db.query(
    `UPDATE review_feedback_operations SET claim_token = NULL, updated_at = ?
     WHERE operation_id = ? AND state != 'done' AND claim_token IS NOT NULL
     RETURNING operation_id`,
    [Date.now(), operationId],
  );
  return released.rows.length > 0;
}
