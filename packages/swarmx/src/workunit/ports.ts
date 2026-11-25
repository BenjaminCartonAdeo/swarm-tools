/**
 * WorkUnit effect ports and the additive runtime seam.
 *
 * `setupWorkUnitRuntime` is opt-in: the default plugin setup leaves `runtime.workUnit`
 * undefined, never migrates legacy KV, writes no tombstone and keeps `runtime.store`.
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
  readonly recovery: { recovered: number; foreignHostCandidates: string[] };
  readonly store: WorkUnitMissionStore;
  readonly commands: MissionCommands;
  /** Builds ports against the runtime and binds them for the command layer's effect drains. */
  createEffectPorts(runtime: Pick<SwarmxRuntime, "runTool">): WorkUnitEffectPorts;
}

export interface SetupWorkUnitRuntimeOptions extends WorkUnitMissionStoreOptions {
  host?: EffectHostIdentity;
  isProcessAlive?: (pid: number) => boolean;
  /** Test seam: observes setup steps in order. */
  trace?: (step: "host" | "schema" | "recovery" | "adapter" | "commands") => void;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

/** host identity -> schema -> stale-effect recovery -> adapter/commands. No migration, no tombstone. */
export async function setupWorkUnitRuntime(
  db: DatabaseAdapter,
  opts: SetupWorkUnitRuntimeOptions = {},
): Promise<WorkUnitRuntime> {
  const { host: hostOption, isProcessAlive: aliveOption, trace, ...storeOptions } = opts;
  const host = hostOption ?? { hostInstanceId: randomUUID(), hostname: osHostname(), pid: process.pid };
  const isProcessAlive = aliveOption ?? defaultIsProcessAlive;
  trace?.("host");
  await ensureWorkUnitSchema(db);
  trace?.("schema");
  const recovery = await recoverStaleEffects(db, { hostInstanceId: host.hostInstanceId, hostname: host.hostname, isProcessAlive });
  trace?.("recovery");
  const store = createWorkUnitMissionStore(db, storeOptions);
  trace?.("adapter");
  let ports: WorkUnitEffectPorts | undefined;
  const commands = createMissionCommands(db, { host, ports: () => ports });
  trace?.("commands");
  return {
    db, host, isProcessAlive, recovery, store, commands,
    createEffectPorts(runtime) {
      ports = createWorkUnitEffectPorts(runtime);
      return ports;
    },
  };
}
