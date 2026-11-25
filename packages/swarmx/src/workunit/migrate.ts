/**
 * One-shot import of the legacy KV lifecycle into the WorkUnit tables.
 *
 * The import is deterministic (stable ids, `ON CONFLICT DO NOTHING`), so it can
 * run again safely. It never terminalizes a live worker because a record is
 * old: ambiguous attempts import as BOUND with `legacy_ambiguous` for manual
 * reconciliation. The KV tombstone is written last, after every row landed.
 */
import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import {
  DEFAULT_WORKER_SHARE,
  LEGACY_TOMBSTONE_PROJECT_SESSION,
  type LegacyLifecycleReader,
  type LegacyLifecycleStore,
  type LegacyPendingCompletion,
  type LegacyReviewReceipt,
} from "../state.js";
import type { DispatchAttempt, MissionState } from "../types.js";
import type { WorkUnitState } from "./schema.js";

export type { LegacyLifecycleReader, LegacyLifecycleStore };

export interface LegacyImportResult {
  imported: number;
  skipped: number;
  tombstoned: boolean;
}

/** A native live mission already owns the session; importing would orphan legacy attempts. */
export class LegacyMissionConflictError extends Error {
  readonly project: string;
  readonly sessionId: string;
  readonly existingMissionPk: string;
  constructor(project: string, sessionId: string, existingMissionPk: string) {
    super(`Legacy mission for ${project}/${sessionId} conflicts with live mission ${existingMissionPk}`);
    this.name = "LegacyMissionConflictError";
    this.project = project;
    this.sessionId = sessionId;
    this.existingMissionPk = existingMissionPk;
  }
}

interface ImportedMission {
  pk: string;
  missionID: string;
  mission: MissionState;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function missionIdOf(mission: MissionState): string {
  return mission.missionID ?? `legacy:${mission.createdAt}`;
}

function belongsTo(attempt: DispatchAttempt, mission: ImportedMission): boolean {
  if (attempt.sessionID !== mission.mission.sessionID) return false;
  if (attempt.missionID !== undefined) return attempt.missionID === mission.missionID;
  return attempt.ts >= mission.mission.createdAt;
}

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

interface Mapped {
  state: WorkUnitState;
  ambiguous: boolean;
}

function mapAttempt(
  attempt: DispatchAttempt,
  completion: LegacyPendingCompletion | undefined,
  receipt: LegacyReviewReceipt | undefined,
): Mapped {
  const identified = attempt.workerSessionID !== undefined && attempt.dispatchToken !== undefined;
  // Completion overlays are later evidence than revokedAt: legacy finalization
  // and cancellation themselves set revokedAt, so they must win over REVOKED.
  if (completion?.canceled === true) return { state: "CANCELLED", ambiguous: false };
  if (completion?.finalized === true) return { state: "DONE", ambiguous: false };
  if (attempt.revokedAt !== undefined) return { state: "REVOKED", ambiguous: false };
  if (attempt.status === "failed") return { state: "FAILED", ambiguous: false };
  if (attempt.status === "aborted") return { state: "ABANDONED", ambiguous: false };
  if (attempt.status === "pending") {
    return attempt.workerSessionID === undefined
      ? { state: "RESERVED", ambiguous: false }
      : { state: "BOUND", ambiguous: !identified };
  }
  if (attempt.followup === true) return { state: "DONE", ambiguous: false };
  if (receipt !== undefined) return { state: receipt.approval === undefined ? "IN_REVIEW" : "APPROVED", ambiguous: false };
  if (completion !== undefined) return { state: "SUBMITTED", ambiguous: false };
  return { state: "BOUND", ambiguous: !identified };
}

/**
 * Imports the legacy lifecycle of one project and tombstones the KV view.
 *
 * Throws (without tombstoning) when any read or write fails; the KV view stays
 * authoritative until a full pass succeeded.
 */
export async function migrateLegacyLifecycle(
  db: DatabaseAdapter,
  input: { project: string; legacyStore: LegacyLifecycleStore },
): Promise<LegacyImportResult> {
  const { project, legacyStore } = input;
  let imported = 0;
  let skipped = 0;
  const now = Date.now();

  const attempts = await legacyStore.listAttempts(project);
  const assignments = await legacyStore.listAssignments(project);
  const completions = await legacyStore.listPendingCompletions(project);
  const receipts = await legacyStore.listReviewReceipts(project);
  const buildLock = await legacyStore.getBuildLock(project);
  const cleanupClaim = await legacyStore.getCleanupClaim(project);

  const sessions = new Set<string>();
  for (const attempt of attempts) sessions.add(attempt.sessionID);
  for (const assignment of assignments) if (assignment.sessionID !== undefined) sessions.add(assignment.sessionID);
  for (const completion of completions) sessions.add(completion.parentSessionID);
  for (const receipt of receipts) sessions.add(receipt.sessionID);
  if (buildLock !== undefined) sessions.add(buildLock.sessionID);

  const missions: ImportedMission[] = [];
  const listed = await legacyStore.listMissions(project);
  for (const mission of listed) sessions.add(mission.sessionID);
  const candidates: ImportedMission[] = [];
  for (const session of [...sessions].sort()) {
    const mission = listed.find((m) => m.sessionID === session) ?? (await legacyStore.getMission(project, session));
    if (mission === undefined) continue;
    const missionID = missionIdOf(mission);
    candidates.push({ pk: `mission:${project}:${session}:${missionID}`, missionID, mission });
  }
  // Pre-flight: a different native live mission on the same session would make the
  // legacy mission insert a no-op while its attempts still import. Abort before any write.
  for (const candidate of candidates) {
    if (!candidate.mission.active) continue;
    const live = await db.query(
      "SELECT id FROM swarmx_missions WHERE project = ? AND session_id = ? AND state IN ('OPEN', 'CLOSING') AND id <> ?",
      [project, candidate.mission.sessionID, candidate.pk],
    );
    const row: unknown = live.rows[0];
    if (row !== undefined) {
      const existing = typeof row === "object" && row !== null ? String(Reflect.get(row, "id")) : "unknown";
      throw new LegacyMissionConflictError(project, candidate.mission.sessionID, existing);
    }
  }
  for (const candidate of candidates) {
    const { pk, missionID, mission } = candidate;
    const session = mission.sessionID;
    missions.push(candidate);
    const workerShare = mission.budget.workerShare ?? DEFAULT_WORKER_SHARE;
    const legacySource = JSON.stringify({
      kind: "legacy_mission",
      raw: mission,
      ...(mission.active ? {} : { close_intent_ambiguous: true }),
    });
    const epicId = mission.consolidation?.epicID ?? attempts.find((a) => a.sessionID === session && a.epicID)?.epicID ?? null;
    const result = await db.query(
      `INSERT INTO swarmx_missions (id, project, session_id, mission_id, epic_id, state, close_intent, fence,
         budget_limit, legacy_source, mode, budget_policy_json, consolidation_json, retry_causes_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        pk,
        project,
        session,
        missionID,
        epicId,
        mission.active ? "OPEN" : "FINISHED",
        mission.budget.maxSpawns,
        legacySource,
        mission.mode,
        JSON.stringify({
          total: mission.budget.maxSpawns,
          perCellIterations: mission.budget.maxIterations,
          workerShare: { agent: "swarm-worker", maxFraction: workerShare },
          version: 1,
        }),
        mission.consolidation === undefined ? null : JSON.stringify(mission.consolidation),
        mission.retryCauses === undefined ? null : JSON.stringify(mission.retryCauses),
        toMs(mission.createdAt),
        toMs(mission.updatedAt),
      ],
    );
    imported += result.rows.length;
  }

  const completionByCall = new Map(completions.map((c) => [c.attemptCallID, c]));
  const receiptByCall = new Map(receipts.map((r) => [r.attemptCallID, r]));
  const previousByCell = new Map<string, { id: string; attemptNo: number }>();
  const cellsWithUnits = new Set<string>();
  const projectCellsWithUnits = new Set<string>();

  for (const attempt of attempts) {
    const owner = missions.find((m) => belongsTo(attempt, m));
    if (owner === undefined) {
      skipped += 1;
      continue;
    }
    const cellKey = `${owner.pk}|${attempt.cellID}`;
    const previous = previousByCell.get(cellKey);
    const attemptNo = (previous?.attemptNo ?? 0) + 1;
    const id = `unit:${project}:${owner.missionID}:${attempt.callID}`;
    previousByCell.set(cellKey, { id, attemptNo });
    const completion = completionByCall.get(attempt.callID);
    const receipt = receiptByCall.get(attempt.callID);
    const mapped = mapAttempt(attempt, completion, receipt);
    const evidenceJson =
      completion === undefined
        ? null
        : JSON.stringify({
            summary: completion.summary,
            filesTouched: completion.filesTouched,
            submittedAt: completion.submittedAt,
            verification: completion.verification ?? null,
          });
    const result = await db.query(
      `INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, retry_of, state,
         fence, dispatch_token, worker_session, worker_agent, budget_charge, evidence_hash, diff_hash, evidence_json,
         review_verdict, review_by, review_feedback_json, verification_receipt_json, reason, error_json, legacy_source,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        project,
        owner.pk,
        attempt.callID,
        attempt.cellID,
        sha256(`${project}|${owner.missionID}|${attempt.cellID}|${attemptNo}`),
        attemptNo,
        previous?.id ?? null,
        mapped.state,
        attempt.dispatchToken ?? null,
        attempt.workerSessionID ?? completion?.workerSessionID ?? null,
        attempt.agent,
        attempt.followup === true ? 0 : 1,
        evidenceJson === null ? null : sha256(evidenceJson),
        receipt?.approval?.diffHash ?? receipt?.diffHash ?? null,
        evidenceJson,
        receipt === undefined ? null : receipt.approval === undefined ? null : "approved",
        receipt?.assignedAgentID ?? null,
        null,
        receipt === undefined ? null : JSON.stringify(receipt),
        completion?.canceled === true ? (completion.cancelReason ?? "legacy_canceled") : null,
        JSON.stringify({
          kind: "legacy_attempt",
          raw: attempt,
          ...(completion === undefined ? {} : { completion }),
          ...(mapped.ambiguous ? { legacy_ambiguous: true } : {}),
        }),
        toMs(attempt.ts),
        toMs(attempt.revokedAt ?? attempt.ts),
      ],
    );
    if (result.rows.length > 0) {
      imported += 1;
    } else {
      const existing = await db.query("SELECT id FROM swarmx_work_units WHERE id = ?", [id]);
      if (existing.rows.length === 0) skipped += 1;
    }
    cellsWithUnits.add(`${owner.pk}|${attempt.cellID}`);
    projectCellsWithUnits.add(attempt.cellID);
  }

  for (const assignment of assignments) {
    const owner =
      assignment.sessionID === undefined
        ? undefined
        : missions.find((m) => m.mission.sessionID === assignment.sessionID);
    const hasUnit =
      owner === undefined
        ? projectCellsWithUnits.has(assignment.cellID)
        : cellsWithUnits.has(`${owner.pk}|${assignment.cellID}`);
    const result = await db.query(
      `INSERT INTO swarmx_legacy_assignments (project, cell_id, owner, raw_json, created_at, mission_pk, agent, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, cell_id) DO NOTHING RETURNING cell_id`,
      [
        project,
        assignment.cellID,
        assignment.sessionID ?? null,
        JSON.stringify({ raw: assignment, ...(hasUnit ? {} : { legacy_ambiguous: true }) }),
        now,
        owner?.pk ?? null,
        assignment.agent,
        hasUnit ? "assigned" : "legacy_ambiguous",
        toMs(assignment.updatedAt),
      ],
    );
    imported += result.rows.length;
  }

  const locks: Array<[string, string, string, number]> = [];
  if (buildLock !== undefined) {
    locks.push([`build:${project}`, `legacy:${buildLock.callID}`, buildLock.sessionID, toMs(buildLock.acquiredAt)]);
  }
  if (cleanupClaim !== undefined) {
    locks.push([
      `cleanup:${project}`,
      `legacy:cleanup:${cleanupClaim.taskID}:${cleanupClaim.at}`,
      "legacy",
      cleanupClaim.at,
    ]);
  }
  for (const [name, token, ownerSession, acquiredAt] of locks) {
    const result = await db.query(
      `INSERT INTO swarmx_locks (name, token, owner_session, fence, acquired_at)
       VALUES (?, ?, ?, 1, ?) ON CONFLICT (name) DO NOTHING RETURNING name`,
      [name, token, ownerSession, acquiredAt],
    );
    imported += result.rows.length;
  }

  // Last write: only after the whole import pass succeeded.
  await legacyStore.setTombstone(project, LEGACY_TOMBSTONE_PROJECT_SESSION, {
    importedAt: now,
    imported,
    skipped,
  });
  return { imported, skipped, tombstoned: true };
}
