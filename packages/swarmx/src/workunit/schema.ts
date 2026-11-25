import type { DatabaseAdapter } from "swarm-mail";

export type WorkUnitState =
  | "RESERVED"
  | "BOUND"
  | "SUBMITTED"
  | "IN_REVIEW"
  | "APPROVED"
  | "PUBLISHING"
  | "RETURNING"
  | "DONE"
  | "CHANGES_REQUESTED"
  | "REJECTED"
  | "CANCELLED"
  | "ABANDONED"
  | "REVOKED"
  | "FAILED";

export type MissionState = "OPEN" | "CLOSING" | "FINISHED" | "CANCELLED" | "ABANDONED";
export type CloseIntent = "finish" | "cancel" | "abandon";
export type EffectState =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "unknown"
  | "failed_optional"
  | "failed_mandatory"
  | "orphaned";
export type EffectKind = "backend_complete" | "backend_feedback" | "consolidate" | `followup:${number}` | "hive_start";

export interface TransitionFence {
  unitId: string;
  expectedState: WorkUnitState;
  unitFence: number;
}

export const LEGAL_WORK_UNIT_TRANSITIONS = {
  RESERVED: ["BOUND", "FAILED", "REVOKED", "CANCELLED", "ABANDONED"],
  BOUND: ["SUBMITTED", "FAILED", "REVOKED", "CANCELLED", "ABANDONED"],
  SUBMITTED: ["IN_REVIEW", "REVOKED", "CANCELLED", "ABANDONED"],
  IN_REVIEW: ["APPROVED", "RETURNING", "REJECTED", "CANCELLED", "ABANDONED"],
  APPROVED: ["PUBLISHING", "CANCELLED", "ABANDONED"],
  PUBLISHING: ["DONE", "FAILED"],
  RETURNING: ["CHANGES_REQUESTED", "FAILED"],
  DONE: [],
  CHANGES_REQUESTED: [],
  REJECTED: [],
  CANCELLED: [],
  ABANDONED: [],
  REVOKED: [],
  FAILED: [],
} as const satisfies Readonly<Record<WorkUnitState, readonly WorkUnitState[]>>;

export interface Mission {
  id: string;
  project: string;
  session_id: string;
  mission_id: string;
  epic_id: string | null;
  state: MissionState;
  close_intent: CloseIntent | null;
  fence: number;
  budget_limit: number | null;
  legacy_source: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkUnit {
  id: string;
  project: string;
  mission_pk: string;
  call_id: string;
  cell_id: string | null;
  idem_key: string;
  attempt_no: number;
  retry_of: string | null;
  state: WorkUnitState;
  fence: number;
  dispatch_token: string | null;
  worker_session: string | null;
  worker_agent: string | null;
  budget_charge: number | null;
  evidence_hash: string | null;
  diff_hash: string | null;
  evidence_json: string | null;
  review_verdict: string | null;
  review_by: string | null;
  review_feedback_json: string | null;
  verification_receipt_json: string | null;
  reason: string | null;
  error_json: string | null;
  legacy_source: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkUnitEffect {
  effect_id: string;
  unit_id: string;
  kind: EffectKind;
  mandatory: boolean;
  operation_id: string | null;
  unit_fence: number;
  state: EffectState;
  attempt: number;
  claim_token: string | null;
  host_instance_id: string | null;
  claimed_hostname: string | null;
  claimed_by_pid: number | null;
  claimed_at: number | null;
  result_json: string | null;
  error_json: string | null;
  request_json: string | null;
  updated_at: number;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS swarmx_missions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    epic_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSING', 'FINISHED', 'CANCELLED', 'ABANDONED')),
    close_intent TEXT CHECK (close_intent IS NULL OR close_intent IN ('finish', 'cancel', 'abandon')),
    fence INTEGER NOT NULL DEFAULT 0,
    budget_limit REAL,
    legacy_source TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project, session_id, mission_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS swarmx_missions_live_session_uq
    ON swarmx_missions (project, session_id) WHERE state IN ('OPEN', 'CLOSING')`,
  `CREATE TABLE IF NOT EXISTS swarmx_work_units (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    mission_pk TEXT NOT NULL,
    call_id TEXT NOT NULL,
    cell_id TEXT,
    idem_key TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    retry_of TEXT,
    state TEXT NOT NULL CHECK (state IN ('RESERVED', 'BOUND', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'PUBLISHING', 'RETURNING', 'DONE', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED', 'ABANDONED', 'REVOKED', 'FAILED')),
    fence INTEGER NOT NULL DEFAULT 0,
    dispatch_token TEXT,
    worker_session TEXT,
    worker_agent TEXT,
    budget_charge REAL,
    evidence_hash TEXT,
    diff_hash TEXT,
    evidence_json TEXT,
    review_verdict TEXT,
    review_by TEXT,
    review_feedback_json TEXT,
    verification_receipt_json TEXT,
    reason TEXT,
    error_json TEXT,
    legacy_source TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project, call_id),
    UNIQUE (project, idem_key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS swarmx_units_live_cell_uq
    ON swarmx_work_units (project, cell_id)
    WHERE cell_id IS NOT NULL AND state NOT IN ('DONE', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED', 'ABANDONED', 'REVOKED', 'FAILED')`,
  `CREATE TABLE IF NOT EXISTS swarmx_effects (
    effect_id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
    operation_id TEXT,
    unit_fence INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'succeeded', 'unknown', 'failed_optional', 'failed_mandatory', 'orphaned')),
    attempt INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    host_instance_id TEXT,
    claimed_hostname TEXT,
    claimed_by_pid INTEGER,
    claimed_at INTEGER,
    result_json TEXT,
    error_json TEXT,
    request_json TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS swarmx_effects_unit_kind_uq
    ON swarmx_effects (unit_id, kind)`,
  `CREATE TABLE IF NOT EXISTS swarmx_locks (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    owner_session TEXT NOT NULL,
    fence INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarmx_legacy_assignments (
    project TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    owner TEXT,
    raw_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project, cell_id)
  )`,
] as const;

export async function ensureWorkUnitSchema(db: DatabaseAdapter): Promise<void> {
  for (const statement of schemaStatements) {
    await db.exec(statement);
  }
  const missionColumns = await db.query("PRAGMA table_info(swarmx_missions)");
  const hasEpicId = missionColumns.rows.some(
    (row) => typeof row === "object" && row !== null && "name" in row && Reflect.get(row, "name") === "epic_id",
  );
  if (!hasEpicId) {
    await db.exec("ALTER TABLE swarmx_missions ADD COLUMN epic_id TEXT");
  }
  const effectColumns = await db.query("PRAGMA table_info(swarmx_effects)");
  const hasRequestJson = effectColumns.rows.some(
    (row) => typeof row === "object" && row !== null && "name" in row && Reflect.get(row, "name") === "request_json",
  );
  if (!hasRequestJson) {
    await db.exec("ALTER TABLE swarmx_effects ADD COLUMN request_json TEXT");
  }
}
