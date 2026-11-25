import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import {
  type CloseIntent,
  type Mission,
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

export class BudgetGateError extends Error {
  readonly gate: "total" | "cell" | "share";
  constructor(gate: "total" | "cell" | "share") {
    super(`WorkUnit reservation exceeds the mission ${gate} budget gate`);
    this.name = "BudgetGateError";
    this.gate = gate;
  }
}

export class BudgetExceededError extends BudgetGateError {
  constructor() {
    super("total");
    this.name = "BudgetExceededError";
  }
}

export class AssignmentMismatchError extends Error {
  constructor() {
    super("WorkUnit reservation or binding does not match the assigned agent");
    this.name = "AssignmentMismatchError";
  }
}

export class BudgetPolicyError extends Error {
  constructor() {
    super("Mission budget policy is malformed or unsupported");
    this.name = "BudgetPolicyError";
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
  workerAgent: string;
  callId: string;
  dispatchToken: string;
  cellId: string;
  budgetCharge: number;
  idemKey: string;
  attemptNo: number;
  retryOf?: string;
}

interface BudgetPolicyV1 {
  total: number;
  perCellIterations: number;
  workerShare: { agent: string; maxFraction: number } | null;
  version: 1;
}

function parseBudgetPolicy(value: unknown): BudgetPolicyV1 {
  if (typeof value !== "string") throw new BudgetPolicyError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BudgetPolicyError();
  }
  if (!isRecord(parsed)) throw new BudgetPolicyError();
  const { total, perCellIterations, workerShare, version } = parsed;
  if (version !== 1 || typeof total !== "number" || !Number.isFinite(total) || total < 0
    || typeof perCellIterations !== "number" || !Number.isSafeInteger(perCellIterations) || perCellIterations < 0) {
    throw new BudgetPolicyError();
  }
  let parsedShare: BudgetPolicyV1["workerShare"] = null;
  if (workerShare !== null) {
    if (!isRecord(workerShare) || typeof workerShare.agent !== "string" || workerShare.agent.length === 0
      || typeof workerShare.maxFraction !== "number" || !Number.isFinite(workerShare.maxFraction)
      || workerShare.maxFraction < 0 || workerShare.maxFraction > 1) {
      throw new BudgetPolicyError();
    }
    parsedShare = { agent: workerShare.agent, maxFraction: workerShare.maxFraction };
  }
  return { total, perCellIterations, workerShare: parsedShare, version: 1 };
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
    && unit.worker_agent === input.workerAgent
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
      (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, retry_of, state, fence, dispatch_token, worker_agent, budget_charge, created_at, updated_at)
     SELECT 'unit:' || m.project || ':' || m.mission_id || ':' || ?,
        m.project, m.id, ?, ?, ?, ?, ?, 'RESERVED', 1, ?, ?, ?, ?, ?
      FROM swarmx_missions AS m
      WHERE m.project = ? AND m.mission_id = ? AND m.session_id = ? AND m.state = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM swarmx_legacy_assignments AS assignment
          WHERE assignment.project = m.project AND assignment.cell_id = ?
            AND assignment.state = 'assigned' AND assignment.owner IS NOT NULL
            AND assignment.agent IS NOT NULL AND assignment.agent <> ?)
        AND CASE WHEN m.budget_policy_json IS NULL THEN
          (m.budget_limit IS NULL OR
            COALESCE((SELECT SUM(existing.budget_charge) FROM swarmx_work_units AS existing WHERE existing.mission_pk = m.id), 0) + ? <= m.budget_limit)
        ELSE CASE WHEN json_valid(m.budget_policy_json) THEN
          CASE WHEN json_type(m.budget_policy_json) = 'object'
            AND json_type(m.budget_policy_json, '$.version') = 'integer'
            AND json_extract(m.budget_policy_json, '$.version') = 1
            AND json_type(m.budget_policy_json, '$.total') IN ('integer', 'real')
            AND json_extract(m.budget_policy_json, '$.total') >= 0
            AND json_extract(m.budget_policy_json, '$.total') <= 1.7976931348623157e308
            AND json_type(m.budget_policy_json, '$.perCellIterations') = 'integer'
            AND json_extract(m.budget_policy_json, '$.perCellIterations') >= 0
            AND json_extract(m.budget_policy_json, '$.perCellIterations') <= 9007199254740991
            AND (json_type(m.budget_policy_json, '$.workerShare') = 'null' OR (
              json_type(m.budget_policy_json, '$.workerShare') = 'object'
              AND json_type(m.budget_policy_json, '$.workerShare.agent') = 'text'
              AND length(json_extract(m.budget_policy_json, '$.workerShare.agent')) > 0
              AND json_type(m.budget_policy_json, '$.workerShare.maxFraction') IN ('integer', 'real')
              AND json_extract(m.budget_policy_json, '$.workerShare.maxFraction') >= 0
              AND json_extract(m.budget_policy_json, '$.workerShare.maxFraction') <= 1))
          THEN
            COALESCE((SELECT SUM(existing.budget_charge) FROM swarmx_work_units AS existing WHERE existing.mission_pk = m.id), 0) + ? <= json_extract(m.budget_policy_json, '$.total')
            AND (? <= 0 OR (SELECT COUNT(existing.id) FROM swarmx_work_units AS existing
              WHERE existing.mission_pk = m.id AND existing.cell_id = ? AND existing.budget_charge > 0)
              < json_extract(m.budget_policy_json, '$.perCellIterations'))
            AND (json_type(m.budget_policy_json, '$.workerShare') = 'null'
              OR json_extract(m.budget_policy_json, '$.workerShare.agent') <> ?
              OR COALESCE((SELECT SUM(existing.budget_charge) FROM swarmx_work_units AS existing
                WHERE existing.mission_pk = m.id AND existing.worker_agent = json_extract(m.budget_policy_json, '$.workerShare.agent')), 0) + ?
                <= json_extract(m.budget_policy_json, '$.workerShare.maxFraction') *
                  (COALESCE((SELECT SUM(existing.budget_charge) FROM swarmx_work_units AS existing WHERE existing.mission_pk = m.id), 0) + ?))
          ELSE 0 END
        ELSE 0 END END
      ON CONFLICT DO NOTHING
      RETURNING *`,
    [
      input.callId, input.callId, input.cellId, input.idemKey, input.attemptNo, input.retryOf ?? null,
      input.dispatchToken, input.workerAgent, input.budgetCharge, now, now, input.project, input.missionId, input.sessionId,
      input.cellId, input.workerAgent, input.budgetCharge, input.budgetCharge, input.budgetCharge,
      input.cellId, input.workerAgent, input.budgetCharge, input.budgetCharge,
    ],
  );
  const insertedRow: unknown = inserted.rows[0];
  if (isRecord(insertedRow)) return insertedRow as unknown as WorkUnit;

  const missionResult = await db.query(
    `SELECT id, session_id, state, budget_limit, budget_policy_json FROM swarmx_missions
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
  const rawPolicy = mission.budget_policy_json;
  const policy = rawPolicy === null || rawPolicy === undefined ? null : parseBudgetPolicy(rawPolicy);
  const assignmentResult = await db.query(
    `SELECT 1 FROM swarmx_legacy_assignments
     WHERE project = ? AND cell_id = ? AND state = 'assigned' AND owner IS NOT NULL
       AND agent IS NOT NULL AND agent <> ? LIMIT 1`,
    [input.project, input.cellId, input.workerAgent],
  );
  if (assignmentResult.rows.length > 0) throw new AssignmentMismatchError();

  const budgetStatsResult = await db.query(
    `SELECT COALESCE(SUM(budget_charge), 0) AS total,
       COALESCE(SUM(CASE WHEN worker_agent = ? THEN budget_charge ELSE 0 END), 0) AS agent_total,
       SUM(CASE WHEN cell_id = ? AND budget_charge > 0 THEN 1 ELSE 0 END) AS cell_iterations
     FROM swarmx_work_units WHERE mission_pk = ?`,
    [policy?.workerShare?.agent ?? "", input.cellId, missionPk],
  );
  const budgetStats: unknown = budgetStatsResult.rows[0];
  const chargedTotal = isRecord(budgetStats) ? (valueAsNumber(budgetStats.total) ?? 0) : 0;
  const cellIterations = isRecord(budgetStats) ? (valueAsNumber(budgetStats.cell_iterations) ?? 0) : 0;
  if (policy !== null) {
    if (chargedTotal + input.budgetCharge > policy.total) throw new BudgetGateError("total");
    if (input.budgetCharge > 0 && cellIterations >= policy.perCellIterations) throw new BudgetGateError("cell");
    const agentTotal = isRecord(budgetStats) ? (valueAsNumber(budgetStats.agent_total) ?? 0) : 0;
    if (policy.workerShare !== null && input.workerAgent === policy.workerShare.agent
      && agentTotal + input.budgetCharge > policy.workerShare.maxFraction * (chargedTotal + input.budgetCharge)) {
      throw new BudgetGateError("share");
    }
  }
  const budgetLimit = valueAsNumber(mission.budget_limit);
  if (policy === null && budgetLimit !== null && chargedTotal + input.budgetCharge > budgetLimit) {
    throw new BudgetExceededError();
  }
  if (policy !== null) throw new ReservationConflictError("WorkUnit reservation failed an undiagnosed budget gate");
  throw new ReservationConflictError("WorkUnit reservation did not match a diagnosable conflict");
}

export async function bindWorkUnit(
  db: DatabaseAdapter,
  input: TransitionFence & { workerSessionId: string; workerAgent: string },
): Promise<WorkUnit> {
  if (!(LEGAL_WORK_UNIT_TRANSITIONS[input.expectedState] as readonly WorkUnitState[]).includes("BOUND")) {
    throw new IllegalTransitionError(input.expectedState, "BOUND");
  }
  const result = await db.query(
    `UPDATE swarmx_work_units
     SET state = 'BOUND', fence = fence + 1, updated_at = ?, worker_session = ?, worker_agent = ?
     WHERE id = ? AND state = ? AND fence = ? AND worker_agent = ? RETURNING *`,
    [Date.now(), input.workerSessionId, input.workerAgent, input.unitId, input.expectedState, input.unitFence, input.workerAgent],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as WorkUnit;
  const current = await getWorkUnit(db, input.unitId);
  if (current !== null && current.state === input.expectedState && current.fence === input.unitFence
    && current.worker_agent !== input.workerAgent) {
    throw new AssignmentMismatchError();
  }
  throw new FenceConflictError(input.unitId, input.expectedState, input.unitFence);
}

const retryableStates = new Set<WorkUnitState>(["CHANGES_REQUESTED", "REJECTED", "ABANDONED", "FAILED", "REVOKED"]);

export interface RetryWorkUnitInput {
  priorUnitId: string;
  sessionId: string;
  workerAgent: string;
  callId: string;
  dispatchToken: string;
  budgetCharge: number;
}

export async function retryWorkUnit(
  db: DatabaseAdapter,
  input: RetryWorkUnitInput,
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
    workerAgent: input.workerAgent,
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

export class MissionFenceConflictError extends Error {
  constructor(missionId: string, expectedFence: number) {
    super(`Mission ${missionId} fence/owner/state conflict at fence ${expectedFence}`);
    this.name = "MissionFenceConflictError";
  }
}

export class MissionNotDrainedError extends Error {
  constructor(missionId: string) {
    super(`Mission ${missionId} still has live WorkUnits`);
    this.name = "MissionNotDrainedError";
  }
}

export interface MissionCloseFence {
  missionPk: string;
  expectedFence: number;
  ownerSessionId: string;
}

export const TERMINAL_WORK_UNIT_STATES_SQL =
  "('DONE', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED', 'ABANDONED', 'REVOKED', 'FAILED')";

export async function getMissionByPk(db: DatabaseAdapter, missionId: string): Promise<Mission | null> {
  const result = await db.query("SELECT * FROM swarmx_missions WHERE id = ?", [missionId]);
  const row: unknown = result.rows[0];
  return isRecord(row) ? (row as unknown as Mission) : null;
}

async function countLiveUnits(db: DatabaseAdapter, missionId: string): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(id) AS n FROM swarmx_work_units WHERE mission_pk = ? AND state NOT IN ${TERMINAL_WORK_UNIT_STATES_SQL}`,
    [missionId],
  );
  const row: unknown = result.rows[0];
  return isRecord(row) ? Number(row.n ?? 0) : 0;
}

/** Fenced OPEN -> CLOSING. Replaying with the pre-close fence and same intent returns the CLOSING row. */
export async function beginMissionClose(
  db: DatabaseAdapter,
  input: MissionCloseFence & { intent: CloseIntent },
): Promise<Mission> {
  const result = await db.query(
    `UPDATE swarmx_missions SET state = 'CLOSING', close_intent = ?, fence = fence + 1, updated_at = ?
     WHERE id = ? AND session_id = ? AND fence = ? AND state = 'OPEN' RETURNING *`,
    [input.intent, Date.now(), input.missionPk, input.ownerSessionId, input.expectedFence],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as Mission;
  const current = await getMissionByPk(db, input.missionPk);
  if (current !== null && current.session_id === input.ownerSessionId && current.state === "CLOSING"
    && current.close_intent === input.intent && Number(current.fence) === input.expectedFence + 1) {
    return current;
  }
  throw new MissionFenceConflictError(input.missionPk, input.expectedFence);
}

/** Idempotent cancel/abandon cascade; PUBLISHING/RETURNING and APPROVED-with-effects are left to drain. */
export async function cascadeMissionClose(
  db: DatabaseAdapter,
  input: MissionCloseFence & { intent: "cancel" | "abandon" },
): Promise<{ unitIds: string[] }> {
  const nextState = input.intent === "cancel" ? "CANCELLED" : "ABANDONED";
  const result = await db.query(
    `UPDATE swarmx_work_units SET state = ?, fence = fence + 1, reason = COALESCE(reason, ?), updated_at = ?
     WHERE mission_pk = ?
       AND (state IN ('RESERVED', 'BOUND', 'SUBMITTED', 'IN_REVIEW')
         OR (state = 'APPROVED' AND NOT EXISTS (
           SELECT 1 FROM swarmx_effects e WHERE e.unit_id = swarmx_work_units.id)))
       AND EXISTS (
         SELECT 1 FROM swarmx_missions m WHERE m.id = swarmx_work_units.mission_pk
           AND m.session_id = ? AND m.fence = ? AND m.state = 'CLOSING' AND m.close_intent = ?)
     RETURNING id`,
    [nextState, `mission_${input.intent}`, Date.now(), input.missionPk, input.ownerSessionId, input.expectedFence, input.intent],
  );
  const unitIds = result.rows.flatMap((row) => (isRecord(row) && typeof row.id === "string" ? [row.id] : []));
  if (unitIds.length > 0) return { unitIds };
  const mission = await getMissionByPk(db, input.missionPk);
  if (mission === null || mission.session_id !== input.ownerSessionId || mission.state !== "CLOSING"
    || mission.close_intent !== input.intent || Number(mission.fence) !== input.expectedFence) {
    throw new MissionFenceConflictError(input.missionPk, input.expectedFence);
  }
  return { unitIds };
}

/** Barrier: CLOSING -> terminal only when no live unit remains, in one conditional statement. */
export async function finishMissionClose(db: DatabaseAdapter, input: MissionCloseFence): Promise<Mission> {
  const result = await db.query(
    `UPDATE swarmx_missions
     SET state = CASE close_intent WHEN 'cancel' THEN 'CANCELLED' WHEN 'abandon' THEN 'ABANDONED' ELSE 'FINISHED' END,
         fence = fence + 1, updated_at = ?
     WHERE id = ? AND session_id = ? AND fence = ? AND state = 'CLOSING'
       AND NOT EXISTS (SELECT 1 FROM swarmx_work_units u
         WHERE u.mission_pk = swarmx_missions.id AND u.state NOT IN ${TERMINAL_WORK_UNIT_STATES_SQL})
     RETURNING *`,
    [Date.now(), input.missionPk, input.ownerSessionId, input.expectedFence],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as Mission;
  const mission = await getMissionByPk(db, input.missionPk);
  if (mission !== null && mission.session_id === input.ownerSessionId) {
    const fence = Number(mission.fence);
    if (["FINISHED", "CANCELLED", "ABANDONED"].includes(mission.state) && fence === input.expectedFence + 1) {
      return mission;
    }
    if (mission.state === "CLOSING" && fence === input.expectedFence && (await countLiveUnits(db, input.missionPk)) > 0) {
      throw new MissionNotDrainedError(input.missionPk);
    }
  }
  throw new MissionFenceConflictError(input.missionPk, input.expectedFence);
}

// ---------------------------------------------------------------------------
// Fixed-purpose fenced APIs used by the actor-checked command layer.
// Tools never receive raw `transitionWorkUnit`; each API names its edge.
// ---------------------------------------------------------------------------

export class SubmissionConflictError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} already holds different submitted evidence`);
    this.name = "SubmissionConflictError";
  }
}

export class WorkerSessionMismatchError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} is bound to a different worker session`);
    this.name = "WorkerSessionMismatchError";
  }
}

export class ReviewIntentConflictError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} already holds a different review intent`);
    this.name = "ReviewIntentConflictError";
  }
}

export class EffectReplayConflictError extends Error {
  constructor(effectId: string) {
    super(`WorkUnit effect ${effectId} exists with a different operation or request`);
    this.name = "EffectReplayConflictError";
  }
}

export class EffectsNotSettledError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} mandatory effect has not succeeded`);
    this.name = "EffectsNotSettledError";
  }
}

const SUBMITTED_OR_LATER = new Set<WorkUnitState>([
  "SUBMITTED", "IN_REVIEW", "APPROVED", "PUBLISHING", "RETURNING", "DONE", "CHANGES_REQUESTED", "REJECTED",
]);

/** Fenced RESERVED -> FAILED when the subagent dispatch definitely failed. */
export async function failDispatch(
  db: DatabaseAdapter,
  input: { unitId: string; unitFence: number; errorJson: string },
): Promise<WorkUnit> {
  return transitionWorkUnit(db, {
    unitId: input.unitId, expectedState: "RESERVED", unitFence: input.unitFence,
    nextState: "FAILED", patch: { kind: "dispatch_failed", errorJson: input.errorJson },
  });
}

export interface SubmitWorkUnitInput {
  unitId: string;
  workerSessionId: string;
  evidenceJson: string;
  evidenceHash: string;
  diffHash: string;
}

function sameSubmission(unit: WorkUnit, input: SubmitWorkUnitInput): boolean {
  return unit.evidence_hash === input.evidenceHash && unit.diff_hash === input.diffHash
    && unit.evidence_json === input.evidenceJson;
}

function submitReplay(unit: WorkUnit | null, input: SubmitWorkUnitInput): WorkUnit {
  if (unit === null || !SUBMITTED_OR_LATER.has(unit.state)) {
    throw new FenceConflictError(input.unitId, "BOUND", unit?.fence ?? -1);
  }
  if (!sameSubmission(unit, input)) throw new SubmissionConflictError(input.unitId);
  return unit;
}

/**
 * Immutable submit: BOUND -> SUBMITTED by the bound worker only. An identical replay
 * in SUBMITTED or later returns the saved unit without a write; different evidence conflicts.
 */
export async function submitWorkUnit(db: DatabaseAdapter, input: SubmitWorkUnitInput): Promise<WorkUnit> {
  const current = await getWorkUnit(db, input.unitId);
  if (current === null) throw new FenceConflictError(input.unitId, "BOUND", -1);
  if (current.state !== "BOUND") return submitReplay(current, input);
  if (current.worker_session !== input.workerSessionId) throw new WorkerSessionMismatchError(input.unitId);
  const result = await db.query(
    `UPDATE swarmx_work_units
     SET state = 'SUBMITTED', fence = fence + 1, updated_at = ?, evidence_hash = ?, diff_hash = ?, evidence_json = ?
     WHERE id = ? AND state = 'BOUND' AND fence = ? AND worker_session = ? RETURNING *`,
    [Date.now(), input.evidenceHash, input.diffHash, input.evidenceJson, input.unitId, current.fence, input.workerSessionId],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as WorkUnit;
  return submitReplay(await getWorkUnit(db, input.unitId), input);
}

/** Fenced SUBMITTED -> IN_REVIEW. Replay by the same reviewer returns the IN_REVIEW row. */
export async function beginReviewWorkUnit(
  db: DatabaseAdapter,
  input: { unitId: string; unitFence: number; reviewBy: string },
): Promise<WorkUnit> {
  try {
    return await transitionWorkUnit(db, {
      unitId: input.unitId, expectedState: "SUBMITTED", unitFence: input.unitFence,
      nextState: "IN_REVIEW", patch: { kind: "begin_review", reviewBy: input.reviewBy },
    });
  } catch (error) {
    const current = await getWorkUnit(db, input.unitId);
    if (current !== null && current.state === "IN_REVIEW" && current.fence === input.unitFence + 1
      && current.review_by === input.reviewBy) {
      return current;
    }
    throw error;
  }
}

export interface ReviewIntent {
  verdict: string;
  reviewer: string;
  receiptJson: string | null;
  feedbackJson: string | null;
}

function intentMatches(unit: WorkUnit, intent: ReviewIntent): boolean {
  return unit.review_verdict === intent.verdict && unit.review_by === intent.reviewer
    && unit.verification_receipt_json === intent.receiptJson && unit.review_feedback_json === intent.feedbackJson;
}

/**
 * Persists the single review intent without bumping the fence. The update is conditional on
 * IN_REVIEW at `reviewFence` with no prior verdict; a different concurrent intent is rejected.
 */
export async function recordReviewIntent(
  db: DatabaseAdapter,
  input: { unitId: string; reviewFence: number; intent: ReviewIntent },
): Promise<WorkUnit> {
  const { intent } = input;
  const result = await db.query(
    `UPDATE swarmx_work_units
     SET review_verdict = ?, verification_receipt_json = ?, review_feedback_json = ?, updated_at = ?
     WHERE id = ? AND state = 'IN_REVIEW' AND fence = ? AND review_by = ? AND review_verdict IS NULL RETURNING *`,
    [intent.verdict, intent.receiptJson, intent.feedbackJson, Date.now(), input.unitId, input.reviewFence, intent.reviewer],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as WorkUnit;
  const current = await getWorkUnit(db, input.unitId);
  if (current === null) throw new FenceConflictError(input.unitId, "IN_REVIEW", input.reviewFence);
  if (current.fence >= input.reviewFence && current.review_verdict !== null) {
    if (intentMatches(current, intent)) return current;
    throw new ReviewIntentConflictError(input.unitId);
  }
  throw new FenceConflictError(input.unitId, "IN_REVIEW", input.reviewFence);
}

export interface ReviewEffectSpec {
  effectId: string;
  kind: "backend_complete" | "backend_feedback";
  mandatory: boolean;
  operationId: string;
  requestJson: string;
  unitFence: number;
}

/**
 * Inserts deterministic review effects guarded by the IN_REVIEW state/fence. Replay verifies the
 * exact operation_id/request_json/unit_fence of rows that already exist.
 */
export async function insertReviewEffects(
  db: DatabaseAdapter,
  input: { unitId: string; reviewFence: number; effects: readonly ReviewEffectSpec[] },
): Promise<void> {
  for (const effect of input.effects) {
    await db.query(
      `INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, operation_id, unit_fence, state, request_json, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
       WHERE EXISTS (SELECT 1 FROM swarmx_work_units WHERE id = ? AND state = 'IN_REVIEW' AND fence = ?)
       ON CONFLICT DO NOTHING`,
      [effect.effectId, input.unitId, effect.kind, effect.mandatory ? 1 : 0, effect.operationId, effect.unitFence,
        effect.requestJson, Date.now(), input.unitId, input.reviewFence],
    );
    const existing = await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effect.effectId]);
    const row: unknown = existing.rows[0];
    if (!isRecord(row)) throw new FenceConflictError(input.unitId, "IN_REVIEW", input.reviewFence);
    if (row.unit_id !== input.unitId || row.kind !== effect.kind || row.operation_id !== effect.operationId
      || row.request_json !== effect.requestJson || Number(row.unit_fence) !== effect.unitFence) {
      throw new EffectReplayConflictError(effect.effectId);
    }
  }
}

export type ReviewDecision =
  | { kind: "approve"; verdict: string }
  | { kind: "request_changes"; verdict: string; feedbackJson: string }
  | { kind: "reject"; verdict: string; reason: string };

const decisionTargets: Record<ReviewDecision["kind"], readonly WorkUnitState[]> = {
  approve: ["APPROVED", "PUBLISHING", "DONE"],
  request_changes: ["RETURNING", "CHANGES_REQUESTED"],
  reject: ["REJECTED"],
};

/** Applies the fenced review decision last; replay after the decision returns the current row. */
export async function applyReviewDecision(
  db: DatabaseAdapter,
  input: { unitId: string; reviewFence: number; decision: ReviewDecision },
): Promise<WorkUnit> {
  const { decision } = input;
  const states = decisionTargets[decision.kind];
  const patch: WorkUnitPatch = decision.kind === "approve"
    ? { kind: "approve", reviewVerdict: decision.verdict }
    : decision.kind === "request_changes"
      ? { kind: "request_changes", reviewVerdict: decision.verdict, reviewFeedbackJson: decision.feedbackJson }
      : { kind: "reject", reviewVerdict: decision.verdict, reason: decision.reason };
  try {
    return await transitionWorkUnit(db, {
      unitId: input.unitId, expectedState: "IN_REVIEW", unitFence: input.reviewFence, nextState: states[0] as WorkUnitState, patch,
    });
  } catch (error) {
    const current = await getWorkUnit(db, input.unitId);
    if (current !== null && current.fence > input.reviewFence && states.includes(current.state)
      && current.review_verdict === decision.verdict) {
      return current;
    }
    throw error;
  }
}

/** Fenced APPROVED -> PUBLISHING; replay returns the later row. */
export async function startPublishing(
  db: DatabaseAdapter,
  input: { unitId: string; unitFence: number },
): Promise<WorkUnit> {
  const result = await db.query(
    `UPDATE swarmx_work_units SET state = 'PUBLISHING', fence = fence + 1, updated_at = ?
     WHERE id = ? AND state = 'APPROVED' AND fence = ? RETURNING *`,
    [Date.now(), input.unitId, input.unitFence],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as WorkUnit;
  const current = await getWorkUnit(db, input.unitId);
  if (current !== null && current.fence > input.unitFence && (current.state === "PUBLISHING" || current.state === "DONE")) {
    return current;
  }
  throw new FenceConflictError(input.unitId, "APPROVED", input.unitFence);
}

async function finalizeAfterEffect(
  db: DatabaseAdapter,
  input: { unitId: string; unitFence: number },
  from: "PUBLISHING" | "RETURNING",
  to: "DONE" | "CHANGES_REQUESTED",
  kind: "backend_complete" | "backend_feedback",
): Promise<WorkUnit> {
  const result = await db.query(
    `UPDATE swarmx_work_units SET state = ?, fence = fence + 1, updated_at = ?
     WHERE id = ? AND state = ? AND fence = ?
       AND EXISTS (SELECT 1 FROM swarmx_effects e WHERE e.unit_id = swarmx_work_units.id
         AND e.kind = ? AND e.state = 'succeeded' AND e.unit_fence = ?)
     RETURNING *`,
    [to, Date.now(), input.unitId, from, input.unitFence, kind, input.unitFence],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as WorkUnit;
  const current = await getWorkUnit(db, input.unitId);
  if (current !== null && current.state === to && current.fence === input.unitFence + 1) return current;
  if (current !== null && current.state === from && current.fence === input.unitFence) {
    throw new EffectsNotSettledError(input.unitId);
  }
  throw new FenceConflictError(input.unitId, from, input.unitFence);
}

/** Fenced PUBLISHING -> DONE, only after the completion effect succeeded. */
export function finalizePublish(db: DatabaseAdapter, input: { unitId: string; unitFence: number }): Promise<WorkUnit> {
  return finalizeAfterEffect(db, input, "PUBLISHING", "DONE", "backend_complete");
}

/** Fenced RETURNING -> CHANGES_REQUESTED, only after the feedback effect succeeded. */
export function finalizeReturn(db: DatabaseAdapter, input: { unitId: string; unitFence: number }): Promise<WorkUnit> {
  return finalizeAfterEffect(db, input, "RETURNING", "CHANGES_REQUESTED", "backend_feedback");
}

// ---------------------------------------------------------------------------
// Completion amendment, unit cancel and consolidation (Task 13d2).
// ---------------------------------------------------------------------------

export class AmendmentConflictError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} completion amendment conflicts with its state, fence, worker or saved amendment`);
    this.name = "AmendmentConflictError";
  }
}

export interface CompletionAmendment {
  version: 1;
  filesTouched: string[];
  reason: string;
  amendedAt: number;
  workerSessionId: string;
  workerAgentId: string;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
}

export function parseCompletionAmendment(json: string | null | undefined): CompletionAmendment | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  const files = stringArray(parsed.filesTouched);
  if (files === null || typeof parsed.reason !== "string" || typeof parsed.amendedAt !== "number"
    || typeof parsed.workerSessionId !== "string" || typeof parsed.workerAgentId !== "string") {
    return null;
  }
  return {
    version: 1, filesTouched: files, reason: parsed.reason, amendedAt: parsed.amendedAt,
    workerSessionId: parsed.workerSessionId, workerAgentId: parsed.workerAgentId,
  };
}

/** Valid amendment files first, otherwise the immutable submitted evidence files. */
export function effectiveCompletionFiles(unit: Pick<WorkUnit, "evidence_json" | "completion_amendment_json">): string[] {
  const amendment = parseCompletionAmendment(unit.completion_amendment_json);
  if (amendment !== null) return amendment.filesTouched;
  if (unit.evidence_json === null) return [];
  try {
    const evidence: unknown = JSON.parse(unit.evidence_json);
    return (isRecord(evidence) ? stringArray(evidence.filesTouched) : null) ?? [];
  } catch {
    return [];
  }
}

const sameFiles = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((file, index) => file === right[index]);

/**
 * SUBMITTED-only amendment by the bound worker at the exact fence. Evidence columns are never
 * rewritten. A miss is idempotent only for a same-worker/same-files/same-reason replay.
 */
export async function amendWorkUnitCompletion(
  db: DatabaseAdapter,
  input: { unitId: string; expectedFence: number; workerSessionId: string; workerAgentId: string; amendmentJson: string },
): Promise<WorkUnit> {
  const requested = parseCompletionAmendment(input.amendmentJson);
  if (requested === null || requested.workerSessionId !== input.workerSessionId
    || requested.workerAgentId !== input.workerAgentId) {
    throw new AmendmentConflictError(input.unitId);
  }
  const result = await db.query(
    `UPDATE swarmx_work_units SET completion_amendment_json = ?, fence = fence + 1, updated_at = ?
     WHERE id = ? AND state = 'SUBMITTED' AND fence = ? AND worker_session = ? AND worker_agent = ? RETURNING *`,
    [input.amendmentJson, Date.now(), input.unitId, input.expectedFence, input.workerSessionId, input.workerAgentId],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as WorkUnit;
  const current = await getWorkUnit(db, input.unitId);
  const saved = current === null ? null : parseCompletionAmendment(current.completion_amendment_json);
  if (current !== null && saved !== null && current.state === "SUBMITTED"
    && current.worker_session === input.workerSessionId && current.worker_agent === input.workerAgentId
    && saved.workerSessionId === input.workerSessionId && saved.reason === requested.reason
    && sameFiles(saved.filesTouched, requested.filesTouched)) {
    return current;
  }
  throw new AmendmentConflictError(input.unitId);
}

/** Fenced SUBMITTED -> CANCELLED with a reason; a same-reason replay returns the cancelled row. */
export async function cancelSubmittedWorkUnit(
  db: DatabaseAdapter,
  input: { unitId: string; unitFence: number; reason: string },
): Promise<WorkUnit> {
  try {
    return await transitionWorkUnit(db, {
      unitId: input.unitId, expectedState: "SUBMITTED", unitFence: input.unitFence,
      nextState: "CANCELLED", patch: { kind: "cancel", reason: input.reason },
    });
  } catch (error) {
    const current = await getWorkUnit(db, input.unitId);
    if (current?.state === "CANCELLED" && current.reason === input.reason && current.fence === input.unitFence + 1) {
      return current;
    }
    throw error;
  }
}

/** Owner/fence guarded consolidation write, OPEN missions only. */
export async function setMissionConsolidation(
  db: DatabaseAdapter,
  input: MissionCloseFence & { consolidationJson: string | null },
): Promise<Mission> {
  const result = await db.query(
    `UPDATE swarmx_missions SET consolidation_json = ?, fence = fence + 1, updated_at = ?
     WHERE id = ? AND session_id = ? AND fence = ? AND state = 'OPEN' RETURNING *`,
    [input.consolidationJson, Date.now(), input.missionPk, input.ownerSessionId, input.expectedFence],
  );
  const row: unknown = result.rows[0];
  if (isRecord(row)) return row as unknown as Mission;
  throw new MissionFenceConflictError(input.missionPk, input.expectedFence);
}
