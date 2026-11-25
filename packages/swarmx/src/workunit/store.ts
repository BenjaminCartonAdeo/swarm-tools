import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import {
  LEGAL_WORK_UNIT_TRANSITIONS,
  type TransitionFence,
  type WorkUnit,
  type WorkUnitState,
} from "./schema.js";

export type WorkUnitPatch =
  | { kind: "bind"; workerSession: string; workerAgent: string }
  | { kind: "submit"; evidenceHash: string; diffHash: string; evidenceJson: string }
  | { kind: "begin_review"; reviewBy: string }
  | { kind: "approve"; reviewVerdict: string }
  | { kind: "request_changes"; reviewVerdict: string; reviewFeedbackJson: string }
  | { kind: "reject"; reviewVerdict: string; reason: string }
  | { kind: "start_publish" }
  | { kind: "finalize" }
  | { kind: "finalize_return" }
  | { kind: "dispatch_failed"; errorJson: string }
  | { kind: "fail"; errorJson: string; reason?: string }
  | { kind: "cancel"; reason: string }
  | { kind: "abandon"; reason: string }
  | { kind: "revoke"; reason: string };

export class IllegalTransitionError extends Error {
  constructor(from: WorkUnitState, to: WorkUnitState) {
    super(`Illegal WorkUnit transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class FenceConflictError extends Error {
  constructor(unitId: string, expectedState: WorkUnitState, unitFence: number) {
    super(`WorkUnit fence conflict for ${unitId} at ${expectedState}/${unitFence}`);
    this.name = "FenceConflictError";
  }
}

export class InvalidPatchError extends Error {
  readonly expectedKind: PatchKind;
  readonly actualKind: PatchKind | undefined;
  constructor(from: WorkUnitState, to: WorkUnitState, expectedKind: PatchKind, actualKind: PatchKind | undefined) {
    super(`Transition ${from} -> ${to} requires patch kind ${expectedKind}, got ${String(actualKind)}`);
    this.name = "InvalidPatchError";
    this.expectedKind = expectedKind;
    this.actualKind = actualKind;
  }
}

export class ReservationConflictError extends Error {
  constructor(message = "WorkUnit reservation conflicts with an existing call") {
    super(message);
    this.name = "ReservationConflictError";
  }
}

export class CallSettledError extends Error {
  constructor(callId: string) {
    super(`WorkUnit call ${callId} is already settled`);
    this.name = "CallSettledError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(idemKey: string) {
    super(`WorkUnit idempotency key ${idemKey} is already assigned`);
    this.name = "IdempotencyConflictError";
  }
}

export class CellBusyError extends Error {
  constructor(cellId: string) {
    super(`Cell ${cellId} already has a live WorkUnit`);
    this.name = "CellBusyError";
  }
}

export class BudgetExceededError extends Error {
  constructor() {
    super("WorkUnit reservation exceeds the mission budget");
    this.name = "BudgetExceededError";
  }
}

export class MissionClosedError extends Error {
  constructor(missionId: string) {
    super(`Mission ${missionId} is missing or is not OPEN`);
    this.name = "MissionClosedError";
  }
}

export class MissionOwnerMismatchError extends Error {
  constructor(missionId: string) {
    super(`Mission ${missionId} is owned by a different session`);
    this.name = "MissionOwnerMismatchError";
  }
}

export class RetryNotAllowedError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} is not in a retryable terminal state`);
    this.name = "RetryNotAllowedError";
  }
}

type PatchKind = WorkUnitPatch["kind"];

type LegalTransitions = typeof LEGAL_WORK_UNIT_TRANSITIONS;
export type LegalTransitionKey = {
  [From in keyof LegalTransitions]: `${From & string}->${LegalTransitions[From][number] & string}`;
}[keyof LegalTransitions];

const transitionPatchKinds: { readonly [K in LegalTransitionKey]: PatchKind } = {
  "RESERVED->BOUND": "bind",
  "BOUND->SUBMITTED": "submit",
  "SUBMITTED->IN_REVIEW": "begin_review",
  "IN_REVIEW->APPROVED": "approve",
  "IN_REVIEW->RETURNING": "request_changes",
  "IN_REVIEW->REJECTED": "reject",
  "APPROVED->PUBLISHING": "start_publish",
  "PUBLISHING->DONE": "finalize",
  "RETURNING->CHANGES_REQUESTED": "finalize_return",
  "RESERVED->FAILED": "dispatch_failed",
  "BOUND->FAILED": "fail",
  "PUBLISHING->FAILED": "fail",
  "RETURNING->FAILED": "fail",
  "RESERVED->CANCELLED": "cancel",
  "BOUND->CANCELLED": "cancel",
  "SUBMITTED->CANCELLED": "cancel",
  "IN_REVIEW->CANCELLED": "cancel",
  "APPROVED->CANCELLED": "cancel",
  "RESERVED->ABANDONED": "abandon",
  "BOUND->ABANDONED": "abandon",
  "SUBMITTED->ABANDONED": "abandon",
  "IN_REVIEW->ABANDONED": "abandon",
  "APPROVED->ABANDONED": "abandon",
  "RESERVED->REVOKED": "revoke",
  "BOUND->REVOKED": "revoke",
  "SUBMITTED->REVOKED": "revoke",
};

interface TransitionInput extends TransitionFence {
  nextState: WorkUnitState;
  patch?: WorkUnitPatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function patchAssignments(patch: WorkUnitPatch): { sql: string[]; values: unknown[] } {
  switch (patch.kind) {
    case "bind":
      return { sql: ["worker_session = ?", "worker_agent = ?"], values: [patch.workerSession, patch.workerAgent] };
    case "submit":
      return {
        sql: ["evidence_hash = ?", "diff_hash = ?", "evidence_json = ?"],
        values: [patch.evidenceHash, patch.diffHash, patch.evidenceJson],
      };
    case "begin_review":
      return { sql: ["review_by = ?"], values: [patch.reviewBy] };
    case "approve":
      return { sql: ["review_verdict = ?"], values: [patch.reviewVerdict] };
    case "request_changes":
      return {
        sql: ["review_verdict = ?", "review_feedback_json = ?", "worker_session = NULL"],
        values: [patch.reviewVerdict, patch.reviewFeedbackJson],
      };
    case "reject":
      return { sql: ["review_verdict = ?", "reason = ?"], values: [patch.reviewVerdict, patch.reason] };
    case "dispatch_failed":
      return { sql: ["error_json = ?"], values: [patch.errorJson] };
    case "fail":
      return {
        sql: ["error_json = ?", ...(patch.reason === undefined ? [] : ["reason = ?"])],
        values: [patch.errorJson, ...(patch.reason === undefined ? [] : [patch.reason])],
      };
    case "cancel":
    case "abandon":
    case "revoke":
      return { sql: ["reason = ?"], values: [patch.reason] };
    case "start_publish":
    case "finalize":
    case "finalize_return":
      return { sql: [], values: [] };
  }
}

export async function transitionWorkUnit(
  db: DatabaseAdapter,
  input: TransitionInput,
): Promise<WorkUnit> {
  const { unitId, expectedState, unitFence, nextState, patch } = input;
  if (!(LEGAL_WORK_UNIT_TRANSITIONS[expectedState] as readonly WorkUnitState[]).includes(nextState)) {
    throw new IllegalTransitionError(expectedState, nextState);
  }

  const expectedPatchKind = transitionPatchKinds[`${expectedState}->${nextState}` as LegalTransitionKey];
  if (patch?.kind !== expectedPatchKind) {
    throw new InvalidPatchError(expectedState, nextState, expectedPatchKind, patch?.kind);
  }

  const assignment = patchAssignments(patch);
  const setClause = ["state = ?", "fence = fence + 1", "updated_at = ?", ...assignment.sql].join(", ");
  const result = await db.query(
    `UPDATE swarmx_work_units SET ${setClause} WHERE id = ? AND state = ? AND fence = ? RETURNING *`,
    [nextState, Date.now(), ...assignment.values, unitId, expectedState, unitFence],
  );
  const row: unknown = result.rows[0];
  if (!isRecord(row)) {
    throw new FenceConflictError(unitId, expectedState, unitFence);
  }
  return row as unknown as WorkUnit;
}

export async function getWorkUnit(db: DatabaseAdapter, unitId: string): Promise<WorkUnit | null> {
  const result = await db.query("SELECT * FROM swarmx_work_units WHERE id = ?", [unitId]);
  const row: unknown = result.rows[0];
  return isRecord(row) ? (row as unknown as WorkUnit) : null;
}

export async function getMissionBudgetUsed(db: DatabaseAdapter, missionPk: string): Promise<number> {
  const result = await db.query(
    "SELECT COALESCE(SUM(budget_charge), 0) AS total FROM swarmx_work_units WHERE mission_pk = ?",
    [missionPk],
  );
  const row: unknown = result.rows[0];
  if (!isRecord(row)) return 0;
  const total = row.total;
  return typeof total === "number" ? total : Number(total ?? 0);
}

export interface ReserveWorkUnitInput {
  project: string;
  missionId: string;
  sessionId: string;
  callId: string;
  dispatchToken: string;
  cellId: string;
  budgetCharge: number;
  idemKey: string;
  attemptNo: number;
  retryOf?: string;
}

function valueAsString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function valueAsNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return null;
}

function sameReservation(unit: WorkUnit, missionPk: string, input: ReserveWorkUnitInput): boolean {
  return unit.mission_pk === missionPk
    && unit.cell_id === input.cellId
    && unit.dispatch_token === input.dispatchToken
    && unit.budget_charge === input.budgetCharge
    && unit.idem_key === input.idemKey
    && unit.attempt_no === input.attemptNo
    && unit.retry_of === (input.retryOf ?? null);
}

function isTerminal(state: WorkUnitState): boolean {
  return LEGAL_WORK_UNIT_TRANSITIONS[state].length === 0;
}

export async function reserveWorkUnit(db: DatabaseAdapter, input: ReserveWorkUnitInput): Promise<WorkUnit> {
  const now = Date.now();
  const inserted = await db.query(
    `INSERT INTO swarmx_work_units
      (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, retry_of, state, fence, dispatch_token, budget_charge, created_at, updated_at)
     SELECT 'unit:' || m.project || ':' || m.mission_id || ':' || ?,
       m.project, m.id, ?, ?, ?, ?, ?, 'RESERVED', 1, ?, ?, ?, ?
     FROM swarmx_missions AS m
     WHERE m.project = ? AND m.mission_id = ? AND m.session_id = ? AND m.state = 'OPEN'
       AND (m.budget_limit IS NULL OR
         COALESCE((SELECT SUM(existing.budget_charge) FROM swarmx_work_units AS existing WHERE existing.mission_pk = m.id), 0) + ? <= m.budget_limit)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.callId, input.callId, input.cellId, input.idemKey, input.attemptNo, input.retryOf ?? null,
      input.dispatchToken, input.budgetCharge, now, now, input.project, input.missionId, input.sessionId,
      input.budgetCharge,
    ],
  );
  const insertedRow: unknown = inserted.rows[0];
  if (isRecord(insertedRow)) return insertedRow as unknown as WorkUnit;

  const missionResult = await db.query(
    `SELECT id, session_id, state, budget_limit FROM swarmx_missions
     WHERE project = ? AND mission_id = ?
     ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END LIMIT 1`,
    [input.project, input.missionId, input.sessionId],
  );
  const mission: unknown = missionResult.rows[0];
  if (!isRecord(mission)) throw new MissionClosedError(input.missionId);
  if (valueAsString(mission.session_id) !== input.sessionId) throw new MissionOwnerMismatchError(input.missionId);

  const missionPk = valueAsString(mission.id);
  if (missionPk === null) throw new MissionClosedError(input.missionId);
  const existingCallResult = await db.query(
    "SELECT * FROM swarmx_work_units WHERE project = ? AND call_id = ?",
    [input.project, input.callId],
  );
  const existingCall: unknown = existingCallResult.rows[0];
  if (isRecord(existingCall)) {
    const unit = existingCall as unknown as WorkUnit;
    if (!sameReservation(unit, missionPk, input)) throw new ReservationConflictError();
    if (isTerminal(unit.state)) throw new CallSettledError(input.callId);
    return unit;
  }

  const idemResult = await db.query(
    "SELECT call_id FROM swarmx_work_units WHERE project = ? AND idem_key = ?",
    [input.project, input.idemKey],
  );
  if (idemResult.rows.length > 0) throw new IdempotencyConflictError(input.idemKey);

  const cellResult = await db.query(
    `SELECT id FROM swarmx_work_units WHERE project = ? AND cell_id = ?
       AND state NOT IN ('DONE', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED', 'ABANDONED', 'REVOKED', 'FAILED')`,
    [input.project, input.cellId],
  );
  if (cellResult.rows.length > 0) throw new CellBusyError(input.cellId);

  if (valueAsString(mission.state) !== "OPEN") throw new MissionClosedError(input.missionId);
  const budgetLimit = valueAsNumber(mission.budget_limit);
  if (budgetLimit !== null && (await getMissionBudgetUsed(db, missionPk)) + input.budgetCharge > budgetLimit) {
    throw new BudgetExceededError();
  }
  throw new ReservationConflictError("WorkUnit reservation did not match a diagnosable conflict");
}

export async function bindWorkUnit(
  db: DatabaseAdapter,
  input: TransitionFence & { workerSessionId: string; workerAgent: string },
): Promise<WorkUnit> {
  return transitionWorkUnit(db, {
    unitId: input.unitId,
    expectedState: input.expectedState,
    unitFence: input.unitFence,
    nextState: "BOUND",
    patch: { kind: "bind", workerSession: input.workerSessionId, workerAgent: input.workerAgent },
  });
}

const retryableStates = new Set<WorkUnitState>(["CHANGES_REQUESTED", "REJECTED", "ABANDONED", "FAILED", "REVOKED"]);

export async function retryWorkUnit(
  db: DatabaseAdapter,
  input: { priorUnitId: string; sessionId: string; callId: string; dispatchToken: string; budgetCharge: number },
): Promise<WorkUnit> {
  const prior = await getWorkUnit(db, input.priorUnitId);
  if (prior === null || !retryableStates.has(prior.state) || prior.cell_id === null) {
    throw new RetryNotAllowedError(input.priorUnitId);
  }
  const missionResult = await db.query(
    "SELECT mission_id FROM swarmx_missions WHERE id = ? AND project = ?",
    [prior.mission_pk, prior.project],
  );
  const mission: unknown = missionResult.rows[0];
  const missionId = isRecord(mission) ? valueAsString(mission.mission_id) : null;
  if (missionId === null) throw new RetryNotAllowedError(input.priorUnitId);
  const attemptNo = prior.attempt_no + 1;
  const idemKey = createHash("sha256")
    .update(`${prior.project}|${missionId}|${prior.cell_id}|${attemptNo}`)
    .digest("hex");
  return reserveWorkUnit(db, {
    project: prior.project,
    missionId,
    sessionId: input.sessionId,
    callId: input.callId,
    dispatchToken: input.dispatchToken,
    cellId: prior.cell_id,
    budgetCharge: input.budgetCharge,
    idemKey,
    attemptNo,
    retryOf: prior.id,
  });
}

export async function recordLegacyAssignment(
  db: DatabaseAdapter,
  input: { project: string; cellId: string; owner?: string },
): Promise<void> {
  const rawJson = JSON.stringify(input.owner === undefined ? {} : { legacy_ambiguous: true });
  await db.query(
    `INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, cell_id) DO NOTHING`,
    [input.project, input.cellId, input.owner ?? null, rawJson, Date.now()],
  );
}
