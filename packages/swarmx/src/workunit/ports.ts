/**
 * WorkUnit effect ports and the additive runtime seam.
 *
 * The default plugin setup calls `setupWorkUnitRuntime` with project-wide migration and
 * installs the result as `runtime.store`/`runtime.workUnit` before tools are registered.
 */
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import type { DatabaseAdapter } from "swarm-mail";
import { LocalToolError, type SwarmxRuntime } from "../types.js";
import { createMissionCommands, type MissionCommands } from "./commands.js";
import {
  DefiniteEffectError,
  type EffectHostIdentity,
  type HiveCellSnapshot,
  recoverStaleEffects,
  type WorkUnitEffectPorts,
} from "./effects.js";
import {
  createWorkUnitMissionStore,
  type WorkUnitMissionStore,
  type WorkUnitMissionStoreOptions,
} from "./mission-store-adapter.js";
import { ensureWorkUnitSchema } from "./schema.js";
import { migrateLegacyLifecycle, type LegacyLifecycleStore } from "./migrate.js";
import { listProjectLifecycleKeys, type MissionStorageLike } from "../state.js";
import { acquireWorkUnitLock, CLEANUP_LOCK_STALE_MS, cleanupLockName, releaseWorkUnitLock } from "./locks.js";
import { completeDowngrade, getOrCreateHostInstanceId, hasLiveMission, isDowngradePending } from "./store.js";

const SWARM_REVIEW_FEEDBACK_TOOL = "swarm_review_feedback";
const HIVE_CELLS_TOOL = "hive_cells";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact `{success:false,error:string}` payload returned by a rejected review feedback. */
function isFeedbackRejection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "error" && keys[1] === "success"
    && value.success === false && typeof value.error === "string";
}

function firstCell(output: unknown, cellId: string): Record<string, unknown> | null {
  const list = Array.isArray(output)
    ? output
    : isRecord(output) && Array.isArray(output.cells) ? output.cells : isRecord(output) ? [output] : [];
  const cells = list.filter(isRecord);
  return cells.find((cell) => cell.id === cellId) ?? (cells.length === 1 && cells[0]?.id === undefined ? cells[0] ?? null : null);
}

/**
 * Effect ports over the runtime tool runner. Backend args are forwarded verbatim. Only an explicit
 * `DefiniteEffectError`, a typed local rejection (`LocalToolError`) or the exact review-feedback
 * rejection payload are definite; everything else stays ambiguous.
 */
export function createWorkUnitEffectPorts(runtime: Pick<SwarmxRuntime, "runTool">): WorkUnitEffectPorts {
  return {
    async readHiveCell(projectKey, cellId): Promise<HiveCellSnapshot | null> {
      const cell = firstCell(await runtime.runTool(HIVE_CELLS_TOOL, { project_key: projectKey, id: cellId }), cellId);
      if (cell === null || typeof cell.status !== "string") return null;
      const completion = cell.completion_operation_id;
      return {
        status: cell.status,
        ...(typeof completion === "string" || completion === null ? { completionOperationId: completion } : {}),
      };
    },
    async runBackendTool(name, args) {
      let result: unknown;
      try {
        result = await runtime.runTool(name, args);
      } catch (error) {
        if (error instanceof DefiniteEffectError) throw error;
        if (error instanceof LocalToolError) throw new DefiniteEffectError(error.message);
        throw error;
      }
      if (name === SWARM_REVIEW_FEEDBACK_TOOL && isFeedbackRejection(result)) {
        throw new DefiniteEffectError(String((result as { error: string }).error));
      }
      return result;
    },
    async prepareConsolidation() {
      throw new DefiniteEffectError("Consolidation effects are not wired in this release");
    },
  };
}

export interface WorkUnitRuntime {
  readonly db: DatabaseAdapter;
  readonly host: EffectHostIdentity;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly recovery: { recovered: number; foreignHostCandidates: string[]; recoveredEffects: string[] };
  readonly store: WorkUnitMissionStore;
  readonly commands: MissionCommands;
  /** Builds ports against the runtime and binds them for the command layer's effect drains. */
  createEffectPorts(runtime: Pick<SwarmxRuntime, "runTool">): WorkUnitEffectPorts;
}

export interface SetupWorkUnitRuntimeOptions extends WorkUnitMissionStoreOptions {
  host?: EffectHostIdentity;
  isProcessAlive?: (pid: number) => boolean;
  /** Project-wide idempotent legacy import, run after the schema and before recovery. */
  migrate?: { project: string; legacyStore: LegacyLifecycleStore };
  /** Test seam: observes setup steps in order. */
  trace?: (step: "host" | "schema" | "migration" | "recovery" | "adapter" | "commands") => void;
}

/** PID liveness probe shared by plugin setup and CLI recovery. Never kills: signal 0 only. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

/** Current host identity, reusing the stable per-hostname instance id persisted in the DB. */
export async function resolveHostIdentity(db: DatabaseAdapter): Promise<EffectHostIdentity> {
  const hostname = osHostname();
  return { hostInstanceId: await getOrCreateHostInstanceId(db, hostname), hostname, pid: process.pid };
}

/**
 * Consumes the current project's pending downgrade request: under the project
 * cleanup SQL lock, rechecks that no mission is live, clears only recognized
 * lifecycle KV keys through raw storage, then marks the request completed.
 * Any failure leaves the request pending for the next setup. DB data is untouched.
 */
export async function consumePendingDowngrade(
  db: DatabaseAdapter,
  rawStorage: MissionStorageLike,
  project: string,
): Promise<{ status: "none" | "deferred" | "completed" | "failed"; clearedKeys?: number }> {
  if (!(await isDowngradePending(db, project))) return { status: "none" };
  const name = cleanupLockName(project);
  const token = randomUUID();
  const lock = await acquireWorkUnitLock(db, {
    name, token, ownerSession: "swarmx-downgrade", now: Date.now(), staleAfterMs: CLEANUP_LOCK_STALE_MS,
  });
  if (!lock.acquired) return { status: "deferred" };
  try {
    if (await hasLiveMission(db, project)) return { status: "deferred" };
    // Raw removals: throws on the first failure (removed keys stay removed; a retry finishes the rest).
    const keys = await listProjectLifecycleKeys(rawStorage, project);
    for (const key of keys) await rawStorage.remove(key);
    const clearedKeys = keys.length;
    await completeDowngrade(db, project, clearedKeys);
    return { status: "completed", clearedKeys };
  } catch {
    return { status: "failed" };
  } finally {
    await releaseWorkUnitLock(db, { name, token, fence: lock.fence });
  }
}

/** host identity -> schema -> stale-effect recovery -> adapter/commands. No migration, no tombstone. */
export async function setupWorkUnitRuntime(
  db: DatabaseAdapter,
  opts: SetupWorkUnitRuntimeOptions = {},
): Promise<WorkUnitRuntime> {
  const { host: hostOption, isProcessAlive: aliveOption, trace, migrate, ...storeOptions } = opts;
  const host = hostOption ?? (await resolveHostIdentity(db));
  const isAlive = aliveOption ?? isProcessAlive;
  trace?.("host");
  await ensureWorkUnitSchema(db);
  trace?.("schema");
  if (migrate !== undefined) {
    await migrateLegacyLifecycle(db, migrate);
    trace?.("migration");
  }
  const recovery = await recoverStaleEffects(db, { hostInstanceId: host.hostInstanceId, hostname: host.hostname, isProcessAlive: isAlive });
  trace?.("recovery");
  const store = createWorkUnitMissionStore(db, storeOptions);
  trace?.("adapter");
  let ports: WorkUnitEffectPorts | undefined;
  const commands = createMissionCommands(db, { host, ports: () => ports });
  trace?.("commands");
  return {
    db, host, isProcessAlive: isAlive, recovery, store, commands,
    createEffectPorts(runtime) {
      ports = createWorkUnitEffectPorts(runtime);
      return ports;
    },
  };
}
