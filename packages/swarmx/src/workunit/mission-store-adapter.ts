/**
 * Read-mostly `MissionStateStore` adapter over the WorkUnit tables.
 *
 * `load`/`list` project native missions and fall back to the read-only legacy view;
 * `save` is an upsert that only writes mode, budget policy and consolidation. Derived
 * fields (active, counts, retry causes, updatedAt) must match a fresh projection.
 * The legacy KV store is never written through this adapter.
 */
import type { DatabaseAdapter } from "swarm-mail";
import { DEFAULT_WORKER_SHARE, type LegacyLifecycleReader, type MissionStateStore } from "../state.js";
import type { ConsolidationState, MissionCellSnapshot, MissionState } from "../types.js";
import {
  type AssignmentRow,
  createMission,
  getMission,
  listUnits,
  type MissionBudgetPolicy,
  setConsolidation,
  updateMissionMode,
  updateMissionPolicy,
} from "./mission.js";
import { projectMission, projectMissionCells } from "./projection.js";
import type { Mission } from "./schema.js";

export class DerivedFieldWriteError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`Mission field ${field} is derived from WorkUnits and cannot be written`);
    this.name = "DerivedFieldWriteError";
    this.field = field;
  }
}

export class MissionSaveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionSaveValidationError";
  }
}

export interface WorkUnitMissionStoreOptions {
  projectID?: string;
  now?: () => number;
  listCells?: (projectID: string) => Promise<MissionCellSnapshot[]>;
  legacyReader?: Pick<LegacyLifecycleReader, "getMission" | "listMissions">;
}

export interface WorkUnitMissionStore extends Pick<MissionStateStore, "load" | "save" | "list"> {
  /** Cell projection of the current native mission (units, assignments, injected Hive cells). */
  loadCells(projectID: string, sessionID: string): Promise<MissionCellSnapshot[]>;
}

const DEFAULT_SHARE_AGENT = "swarm-worker";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function storedPolicy(mission: Mission): MissionBudgetPolicy | null {
  if (mission.budget_policy_json === null) return null;
  try {
    const parsed: unknown = JSON.parse(mission.budget_policy_json);
    return isRecord(parsed) ? (parsed as unknown as MissionBudgetPolicy) : null;
  } catch {
    return null;
  }
}

function policyFrom(state: MissionState, shareAgent: string): MissionBudgetPolicy {
  return {
    total: state.budget.maxSpawns,
    perCellIterations: state.budget.maxIterations,
    workerShare: { agent: shareAgent, maxFraction: state.budget.workerShare ?? DEFAULT_WORKER_SHARE },
    version: 1,
  };
}

async function listAssignments(db: DatabaseAdapter, missionPk: string): Promise<AssignmentRow[]> {
  const result = await db.query("SELECT * FROM swarmx_legacy_assignments WHERE mission_pk = ? ORDER BY cell_id", [missionPk]);
  return result.rows.flatMap((row) => (isRecord(row) ? [row as unknown as AssignmentRow] : []));
}

async function project(db: DatabaseAdapter, mission: Mission): Promise<MissionState> {
  return projectMission({ mission, units: await listUnits(db, mission.id), assignments: await listAssignments(db, mission.id) });
}

async function findGeneration(db: DatabaseAdapter, state: MissionState): Promise<Mission | null> {
  const result = await db.query(
    "SELECT * FROM swarmx_missions WHERE project = ? AND session_id = ? AND mission_id = ?",
    [state.projectID, state.sessionID, state.missionID ?? ""],
  );
  const row: unknown = result.rows[0];
  return isRecord(row) ? (row as unknown as Mission) : null;
}

function missionKey(state: MissionState): string {
  return `${state.missionID ?? ""}|${state.projectID}|${state.sessionID}`;
}

function compareStates(left: MissionState, right: MissionState): number {
  return left.createdAt.localeCompare(right.createdAt) || missionKey(left).localeCompare(missionKey(right));
}

function validateCreation(state: MissionState): number {
  if (!nonEmpty(state.projectID) || !nonEmpty(state.sessionID) || !nonEmpty(state.missionID)) {
    throw new MissionSaveValidationError("Mission creation requires nonempty projectID, sessionID and missionID");
  }
  if (state.active !== true) throw new MissionSaveValidationError("Mission creation requires active === true");
  const { counts } = state;
  if (counts.spawns !== 0 || counts.cells !== 0 || counts.workerSpawns !== 0 || Object.keys(counts.attemptsByCell).length > 0) {
    throw new MissionSaveValidationError("Mission creation requires zero counts; legacy counts are not importable here");
  }
  const created = Date.parse(state.createdAt);
  if (!Number.isFinite(created) || state.createdAt !== state.updatedAt) {
    throw new MissionSaveValidationError("Mission creation requires equal valid createdAt/updatedAt timestamps");
  }
  return created;
}

function assertDerived(state: MissionState, fresh: MissionState): void {
  if (state.createdAt !== fresh.createdAt) throw new MissionSaveValidationError("Mission createdAt is immutable");
  if (state.active !== fresh.active) throw new DerivedFieldWriteError("active");
  if (canonical(state.counts) !== canonical(fresh.counts)) throw new DerivedFieldWriteError("counts");
  if (canonical(state.retryCauses ?? []) !== canonical(fresh.retryCauses ?? [])) throw new DerivedFieldWriteError("retryCauses");
  if (state.updatedAt !== fresh.updatedAt) throw new DerivedFieldWriteError("updatedAt");
}

export function createWorkUnitMissionStore(
  db: DatabaseAdapter,
  opts: WorkUnitMissionStoreOptions = {},
): WorkUnitMissionStore {
  const now = opts.now ?? Date.now;

  async function load(projectID: string, sessionID: string): Promise<MissionState | undefined> {
    const native = await getMission(db, projectID, sessionID);
    if (native !== null) return project(db, native);
    return opts.legacyReader?.getMission(projectID, sessionID);
  }

  async function list(): Promise<MissionState[]> {
    const projects = opts.projectID === undefined
      ? (await db.query("SELECT DISTINCT project FROM swarmx_missions ORDER BY project")).rows
        .flatMap((row) => (isRecord(row) && typeof row.project === "string" ? [row.project] : []))
      : [opts.projectID];
    const byKey = new Map<string, MissionState>();
    for (const projectID of projects) {
      const sessions = await db.query("SELECT DISTINCT session_id FROM swarmx_missions WHERE project = ?", [projectID]);
      for (const row of sessions.rows) {
        if (!isRecord(row) || typeof row.session_id !== "string") continue;
        const current = await getMission(db, projectID, row.session_id);
        if (current !== null) byKey.set(`${projectID}\u0000${row.session_id}`, await project(db, current));
      }
    }
    if (opts.projectID !== undefined && opts.legacyReader !== undefined) {
      const nativeKeys = new Set(byKey.keys());
      const legacy = [...(await opts.legacyReader.listMissions(opts.projectID))].sort(compareStates);
      for (const state of legacy) {
        const key = `${state.projectID}\u0000${state.sessionID}`;
        if (!nativeKeys.has(key)) byKey.set(key, state);
      }
    }
    return [...byKey.values()].sort(compareStates);
  }

  async function save(state: MissionState): Promise<void> {
    const existing = await findGeneration(db, state);
    if (existing === null) {
      const created = validateCreation(state);
      await createMission(db, {
        project: state.projectID,
        sessionId: state.sessionID,
        missionId: state.missionID,
        mode: state.mode,
        budgetPolicy: policyFrom(state, DEFAULT_SHARE_AGENT),
        consolidation: state.consolidation ?? null,
        ...(state.retryCauses === undefined ? {} : { retryCauses: state.retryCauses }),
        now: created,
      });
      return;
    }
    assertDerived(state, await project(db, existing));
    let mission = existing;
    if (state.mode !== mission.mode) {
      mission = await updateMissionMode(db, { missionPk: mission.id, expectedFence: Number(mission.fence), mode: state.mode, now: now() });
    }
    const current = storedPolicy(mission);
    const desired = policyFrom(state, current?.workerShare?.agent ?? DEFAULT_SHARE_AGENT);
    if (current === null || canonical(current) !== canonical(desired)) {
      mission = await updateMissionPolicy(db, { missionPk: mission.id, expectedFence: Number(mission.fence), budgetPolicy: desired, now: now() });
    }
    const storedConsolidation: ConsolidationState | null = mission.consolidation_json === null
      ? null
      : JSON.parse(mission.consolidation_json) as ConsolidationState;
    if (canonical(storedConsolidation) !== canonical(state.consolidation ?? null)) {
      mission = await setConsolidation(db, {
        missionPk: mission.id, expectedFence: Number(mission.fence), consolidation: state.consolidation ?? null, now: now(),
      });
    }
  }

  async function loadCells(projectID: string, sessionID: string): Promise<MissionCellSnapshot[]> {
    const mission = await getMission(db, projectID, sessionID);
    if (mission === null) return [];
    const cells = opts.listCells === undefined ? [] : await opts.listCells(projectID);
    return projectMissionCells({
      mission, units: await listUnits(db, mission.id), assignments: await listAssignments(db, mission.id), cells,
    });
  }

  return { load, save, list, loadCells };
}
