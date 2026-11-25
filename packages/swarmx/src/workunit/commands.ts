/**
 * Actor-checked mission commands over the fixed-purpose WorkUnit store APIs.
 *
 * Coordinator commands require the mission owner session; worker submit requires the
 * bound worker session. Raw `transitionWorkUnit` is never exposed here.
 */
import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "swarm-mail";
import { drainWorkUnitEffects, type EffectHostIdentity, type WorkUnitEffectPorts } from "./effects.js";
import { assignCell as assignMissionCell, type AssignmentRow, getMissionByPk, releaseAssignment as releaseMissionAssignment } from "./mission.js";
import type { Mission, WorkUnit, WorkUnitEffect } from "./schema.js";
import {
  applyReviewDecision,
  beginMissionClose,
  beginReviewWorkUnit,
  bindWorkUnit,
  cascadeMissionClose,
  failDispatch,
  finalizePublish,
  finalizeReturn,
  finishMissionClose,
  getWorkUnit,
  insertReviewEffects,
  MissionClosedError,
  type ReserveWorkUnitInput,
  reserveWorkUnit,
  type ReviewDecision,
  type ReviewEffectSpec,
  type ReviewIntent,
  recordReviewIntent,
  RetryNotAllowedError,
  retryWorkUnit,
  startPublishing,
  submitWorkUnit,
  FenceConflictError,
  amendWorkUnitCompletion,
  cancelSubmittedWorkUnit,
  effectiveCompletionFiles,
  setMissionConsolidation,
} from "./store.js";

export { effectiveCompletionFiles };

export type MissionActor = { kind: "worker"; sessionId: string } | { kind: "coordinator"; sessionId: string };

export class MissionActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionActorError";
  }
}

export class ReviewReceiptRequiredError extends Error {
  constructor(unitId: string) {
    super(`WorkUnit ${unitId} approval requires a verification receipt (unverifiable is limited to doc-only/empty work)`);
    this.name = "ReviewReceiptRequiredError";
  }
}

export class ReviewPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPayloadError";
  }
}

export type ReviewStatus = "approved" | "unverifiable" | "needs_changes" | "rejected";

export interface ReviewInput {
  unitId: string;
  status: ReviewStatus;
  receipt?: Record<string, unknown>;
  feedback?: unknown;
  reason?: string;
  /** Completion summary forwarded to the backend `summary` (required for approvals). */
  summary?: string;
  completionArgs?: Record<string, unknown>;
  /** Filesystem project path forwarded as backend `project_key` (never the OpenCode project id). */
  projectPath?: string;
}

export interface ReviewResult {
  unit: WorkUnit;
  effects: WorkUnitEffect[];
}

export type DispatchOutcome =
  | { ok: true; workerSessionId: string; workerAgent: string }
  | { ok: false; error: unknown };

export interface MissionCommands {
  reserve(actor: MissionActor, input: Omit<ReserveWorkUnitInput, "sessionId">): Promise<WorkUnit>;
  settleDispatch(actor: MissionActor, input: { unitId: string; unitFence: number; outcome: DispatchOutcome }): Promise<WorkUnit>;
  bindWorker(actor: MissionActor, input: { unitId: string; unitFence: number; workerSessionId: string; workerAgent: string }): Promise<WorkUnit>;
  submit(actor: MissionActor, input: { unitId: string; evidence: unknown; diff?: string }): Promise<WorkUnit>;
  beginReview(actor: MissionActor, input: { unitId: string; reviewDiffHash?: string }): Promise<WorkUnit>;
  review(actor: MissionActor, input: ReviewInput): Promise<ReviewResult>;
  cancel(actor: MissionActor, input: { missionPk: string }): Promise<Mission>;
  finish(actor: MissionActor, input: { missionPk: string }): Promise<Mission>;
  retry(actor: MissionActor, input: { priorUnitId: string; workerAgent: string; callId: string; dispatchToken: string; budgetCharge: number }): Promise<WorkUnit>;
  assignCell(actor: MissionActor, input: { missionPk: string; cellId: string; agent: string }): Promise<AssignmentRow>;
  releaseAssignment(actor: MissionActor, input: { missionPk: string; cellId: string }): Promise<AssignmentRow>;
  amendCompletion(actor: MissionActor, input: { unitId: string; filesTouched: string[]; reason: string }): Promise<WorkUnit>;
  cancelCompletion(actor: MissionActor, input: { unitId: string; reason: string }): Promise<WorkUnit>;
  setConsolidation(actor: MissionActor, input: { missionPk: string; expectedFence: number; consolidation: unknown }): Promise<Mission>;
}

export interface MissionCommandsOptions {
  host: EffectHostIdentity;
  ports?: () => WorkUnitEffectPorts | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic JSON: object keys sorted, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Paths that are documentation or static assets (mirrors the catalog's review exception). */
function isDocOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.toLowerCase().endsWith(".md")) return true;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.includes("assets") || segments.includes("docs");
}

function docOnlyEvidence(unit: WorkUnit): boolean {
  if (unit.evidence_json === null) return false;
  return effectiveCompletionFiles(unit).every((path) => isDocOnlyPath(path));
}

/** Builds the review intent, decision and deterministic effects for an IN_REVIEW unit. */
export function reviewEffectPlan(
  unit: WorkUnit,
  input: ReviewInput,
): { intent: ReviewIntent; decision: ReviewDecision; effects: ReviewEffectSpec[] } {
  const reviewer = unit.review_by ?? "";
  const reviewFence = unit.fence;
  const approval = input.status === "approved" || input.status === "unverifiable";
  if (approval && input.receipt === undefined && !(input.status === "unverifiable" && docOnlyEvidence(unit))) {
    throw new ReviewReceiptRequiredError(unit.id);
  }
  if (input.receipt !== undefined && !isRecord(input.receipt)) throw new ReviewReceiptRequiredError(unit.id);
  const receiptJson = approval && input.receipt !== undefined ? canonicalJson(input.receipt) : null;
  const workerAgent = unit.worker_agent;
  if ((approval || input.status === "needs_changes") && (workerAgent === null || workerAgent.length === 0)) {
    throw new ReviewPayloadError(`WorkUnit ${unit.id} has no bound worker agent for the backend effect`);
  }
  const projectKey = input.projectPath;
  if ((approval || input.status === "needs_changes") && (typeof projectKey !== "string" || projectKey.length === 0)) {
    throw new ReviewPayloadError(`WorkUnit ${unit.id} review requires the project path for the backend effect`);
  }
  if (approval) {
    const summary = input.summary ?? input.completionArgs?.summary;
    if (typeof summary !== "string" || summary.trim().length === 0) {
      throw new ReviewPayloadError(`WorkUnit ${unit.id} approval requires a nonempty completion summary`);
    }
    const operationId = `op:${unit.id}:backend_complete`;
    return {
      intent: { verdict: input.status, reviewer, receiptJson, feedbackJson: null },
      decision: { kind: "approve", verdict: input.status },
      effects: [{
        effectId: `effect:${unit.id}:backend_complete`, kind: "backend_complete", mandatory: true, operationId,
        requestJson: canonicalJson({
          ...input.completionArgs, project_key: projectKey, bead_id: unit.cell_id, agent_name: workerAgent, summary,
        }),
        unitFence: reviewFence + 2,
      }],
    };
  }
  const feedbackJson = canonicalJson(input.feedback ?? null);
  if (input.status === "rejected") {
    return {
      intent: { verdict: "rejected", reviewer, receiptJson: null, feedbackJson },
      decision: { kind: "reject", verdict: "rejected", reason: input.reason ?? "rejected" },
      effects: [],
    };
  }
  return {
    intent: { verdict: "needs_changes", reviewer, receiptJson: null, feedbackJson },
    decision: { kind: "request_changes", verdict: "needs_changes", feedbackJson },
    effects: [{
      effectId: `effect:${unit.id}:backend_feedback`, kind: "backend_feedback", mandatory: true,
      operationId: `op:${unit.id}:backend_feedback`,
      requestJson: canonicalJson({
        project_key: projectKey, task_id: unit.cell_id, worker_id: workerAgent, status: "needs_changes",
        ...(input.feedback === undefined ? {} : {
          issues: typeof input.feedback === "string" ? input.feedback : JSON.stringify(input.feedback),
        }),
      }),
      unitFence: reviewFence + 1,
    }],
  };
}

const reviewFenceOffset: Partial<Record<WorkUnit["state"], number>> = {
  IN_REVIEW: 0, APPROVED: 1, PUBLISHING: 2, DONE: 3, RETURNING: 1, CHANGES_REQUESTED: 2, REJECTED: 1,
};

async function listEffects(db: DatabaseAdapter, unitId: string): Promise<WorkUnitEffect[]> {
  const result = await db.query("SELECT * FROM swarmx_effects WHERE unit_id = ? ORDER BY effect_id", [unitId]);
  return result.rows.flatMap((row) => (isRecord(row) ? [row as unknown as WorkUnitEffect] : []));
}

export function createMissionCommands(db: DatabaseAdapter, opts: MissionCommandsOptions): MissionCommands {
  async function ownedMission(actor: MissionActor, missionPk: string): Promise<Mission> {
    if (actor.kind !== "coordinator") throw new MissionActorError("Coordinator command invoked by a worker actor");
    const mission = await getMissionByPk(db, missionPk);
    if (mission === null) throw new MissionClosedError(missionPk);
    if (mission.session_id !== actor.sessionId) throw new MissionActorError(`Session ${actor.sessionId} does not own mission ${missionPk}`);
    return mission;
  }

  async function ownedUnit(actor: MissionActor, unitId: string): Promise<{ unit: WorkUnit; mission: Mission }> {
    if (actor.kind !== "coordinator") throw new MissionActorError("Coordinator command invoked by a worker actor");
    const unit = await getWorkUnit(db, unitId);
    if (unit === null) throw new FenceConflictError(unitId, "RESERVED", -1);
    return { unit, mission: await ownedMission(actor, unit.mission_pk) };
  }

  async function bindWorker(actor: MissionActor, input: { unitId: string; unitFence: number; workerSessionId: string; workerAgent: string }) {
    await ownedUnit(actor, input.unitId);
    try {
      return await bindWorkUnit(db, {
        unitId: input.unitId, expectedState: "RESERVED", unitFence: input.unitFence,
        workerSessionId: input.workerSessionId, workerAgent: input.workerAgent,
      });
    } catch (error) {
      if (!(error instanceof FenceConflictError)) throw error;
      // A concurrent bind for the exact same worker identity already won: idempotent success.
      const current = await getWorkUnit(db, input.unitId);
      if (
        current?.state === "BOUND" &&
        current.worker_session === input.workerSessionId &&
        current.worker_agent === input.workerAgent
      ) return current;
      throw error;
    }
  }

  async function beginReview(actor: MissionActor, input: { unitId: string; reviewDiffHash?: string }): Promise<WorkUnit> {
    const { unit } = await ownedUnit(actor, input.unitId);
    if (unit.state === "IN_REVIEW" && unit.review_by === actor.sessionId) {
      if (input.reviewDiffHash !== undefined && unit.review_diff_hash !== input.reviewDiffHash) {
        throw new FenceConflictError(unit.id, "SUBMITTED", unit.fence);
      }
      return unit;
    }
    return beginReviewWorkUnit(db, {
      unitId: unit.id, unitFence: unit.fence, reviewBy: actor.sessionId, reviewDiffHash: input.reviewDiffHash ?? null,
    });
  }

  async function drain(unitId: string): Promise<void> {
    const ports = opts.ports?.();
    if (ports !== undefined) await drainWorkUnitEffects(db, { unitId, host: opts.host, ports });
  }

  async function review(actor: MissionActor, input: ReviewInput): Promise<ReviewResult> {
    const { unit: initial } = await ownedUnit(actor, input.unitId);
    // Validate the receipt rules before any write.
    reviewEffectPlan({ ...initial, review_by: actor.sessionId }, input);
    const unit = initial.state === "SUBMITTED" ? await beginReview(actor, input) : initial;
    const offset = reviewFenceOffset[unit.state];
    if (offset === undefined || unit.review_by !== actor.sessionId) throw new FenceConflictError(unit.id, "IN_REVIEW", unit.fence);
    const reviewFence = unit.fence - offset;
    const plan = reviewEffectPlan({ ...unit, fence: reviewFence }, input);
    await recordReviewIntent(db, { unitId: unit.id, reviewFence, intent: plan.intent });
    await insertReviewEffects(db, { unitId: unit.id, reviewFence, effects: plan.effects });
    let current = await applyReviewDecision(db, { unitId: unit.id, reviewFence, decision: plan.decision });
    if (current.state === "APPROVED") current = await startPublishing(db, { unitId: unit.id, unitFence: current.fence });
    if (current.state === "PUBLISHING" || current.state === "RETURNING") {
      await drain(unit.id);
      const effects = await listEffects(db, unit.id);
      const kind = current.state === "PUBLISHING" ? "backend_complete" : "backend_feedback";
      if (effects.some((effect) => effect.kind === kind && effect.state === "succeeded")) {
        current = current.state === "PUBLISHING"
          ? await finalizePublish(db, { unitId: unit.id, unitFence: current.fence })
          : await finalizeReturn(db, { unitId: unit.id, unitFence: current.fence });
      }
    }
    return { unit: (await getWorkUnit(db, unit.id)) ?? current, effects: await listEffects(db, unit.id) };
  }

  async function close(actor: MissionActor, missionPk: string, intent: "finish" | "cancel"): Promise<Mission> {
    let mission = await ownedMission(actor, missionPk);
    if (mission.state === "OPEN") {
      mission = await beginMissionClose(db, { missionPk, expectedFence: Number(mission.fence), ownerSessionId: actor.sessionId, intent });
    }
    if (mission.state !== "CLOSING") return mission;
    const fence = { missionPk, expectedFence: Number(mission.fence), ownerSessionId: actor.sessionId };
    if (intent === "cancel") await cascadeMissionClose(db, { ...fence, intent });
    return finishMissionClose(db, fence);
  }

  return {
    async reserve(actor, input) {
      if (actor.kind !== "coordinator") throw new MissionActorError("Coordinator command invoked by a worker actor");
      const result = await db.query("SELECT id FROM swarmx_missions WHERE project = ? AND mission_id = ?", [input.project, input.missionId]);
      const row: unknown = result.rows[0];
      if (!isRecord(row) || typeof row.id !== "string") throw new MissionClosedError(input.missionId);
      await ownedMission(actor, row.id);
      return reserveWorkUnit(db, { ...input, sessionId: actor.sessionId });
    },
    async settleDispatch(actor, input) {
      if (input.outcome.ok) {
        return bindWorker(actor, {
          unitId: input.unitId, unitFence: input.unitFence,
          workerSessionId: input.outcome.workerSessionId, workerAgent: input.outcome.workerAgent,
        });
      }
      await ownedUnit(actor, input.unitId);
      return failDispatch(db, { unitId: input.unitId, unitFence: input.unitFence, errorJson: canonicalJson(input.outcome.error) });
    },
    bindWorker,
    async submit(actor, input) {
      if (actor.kind !== "worker") throw new MissionActorError("Submit requires the bound worker actor");
      const unit = await getWorkUnit(db, input.unitId);
      if (unit === null) throw new FenceConflictError(input.unitId, "BOUND", -1);
      if (unit.worker_session !== null && unit.worker_session !== actor.sessionId) {
        throw new MissionActorError(`Worker ${actor.sessionId} is not bound to WorkUnit ${unit.id}`);
      }
      const evidenceJson = canonicalJson(input.evidence);
      return submitWorkUnit(db, {
        unitId: input.unitId, workerSessionId: actor.sessionId, evidenceJson,
        evidenceHash: sha256(evidenceJson), diffHash: sha256(input.diff ?? ""),
      });
    },
    beginReview,
    review,
    cancel: (actor, input) => close(actor, input.missionPk, "cancel"),
    finish: (actor, input) => close(actor, input.missionPk, "finish"),
    async retry(actor, input) {
      const { unit } = await ownedUnit(actor, input.priorUnitId);
      if (unit.state !== "CHANGES_REQUESTED" || input.workerAgent.trim().length === 0) {
        throw new RetryNotAllowedError(input.priorUnitId);
      }
      return retryWorkUnit(db, { ...input, sessionId: actor.sessionId });
    },
    async assignCell(actor, input) {
      const mission = await ownedMission(actor, input.missionPk);
      if (mission.state !== "OPEN") throw new MissionClosedError(input.missionPk);
      return assignMissionCell(db, {
        project: mission.project, cellId: input.cellId, missionPk: mission.id, agent: input.agent, ownerSessionId: actor.sessionId,
      });
    },
    async releaseAssignment(actor, input) {
      const mission = await ownedMission(actor, input.missionPk);
      return releaseMissionAssignment(db, {
        project: mission.project, cellId: input.cellId, missionPk: mission.id, ownerSessionId: actor.sessionId,
      });
    },
    async amendCompletion(actor, input) {
      if (actor.kind !== "worker") throw new MissionActorError("Amendment requires the bound worker actor");
      const unit = await getWorkUnit(db, input.unitId);
      if (unit === null) throw new FenceConflictError(input.unitId, "SUBMITTED", -1);
      if (unit.worker_session !== actor.sessionId || unit.worker_agent === null) {
        throw new MissionActorError(`Worker ${actor.sessionId} is not bound to WorkUnit ${unit.id}`);
      }
      if (unit.state !== "SUBMITTED") throw new FenceConflictError(unit.id, "SUBMITTED", unit.fence);
      return amendWorkUnitCompletion(db, {
        unitId: unit.id, expectedFence: unit.fence, workerSessionId: actor.sessionId, workerAgentId: unit.worker_agent,
        amendmentJson: JSON.stringify({
          version: 1, filesTouched: input.filesTouched, reason: input.reason, amendedAt: Date.now(),
          workerSessionId: actor.sessionId, workerAgentId: unit.worker_agent,
        }),
      });
    },
    async cancelCompletion(actor, input) {
      const { unit } = await ownedUnit(actor, input.unitId);
      if (unit.state === "CANCELLED" && unit.reason === input.reason) return unit;
      if (unit.state !== "SUBMITTED") throw new FenceConflictError(unit.id, "SUBMITTED", unit.fence);
      return cancelSubmittedWorkUnit(db, { unitId: unit.id, unitFence: unit.fence, reason: input.reason });
    },
    async setConsolidation(actor, input) {
      const mission = await ownedMission(actor, input.missionPk);
      if (mission.state !== "OPEN") throw new MissionClosedError(input.missionPk);
      return setMissionConsolidation(db, {
        missionPk: mission.id, expectedFence: input.expectedFence, ownerSessionId: actor.sessionId,
        consolidationJson: input.consolidation === null ? null : canonicalJson(input.consolidation),
      });
    },
  };
}
