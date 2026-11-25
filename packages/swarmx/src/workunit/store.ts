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
