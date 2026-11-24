/**
 * swarmx — OpenCode V2 plugin entry point.
 *
 * Registers the 82-spec tool catalogue (Task 3) and wires the mission runtime:
 *
 *   - `execute.before` → dispatch gate (throws to refuse a `subagent` call);
 *   - `execute.after`  → idempotent ledger settlement (never throws);
 *   - `compaction`     → bounded factual summary pushed on `event.system`
 *     (never `event.result`, so the host model compaction still runs).
 *
 * Outside an active mission every hook is a pure no-op.
 */
import { Plugin } from "@opencode/plugin";

import { pendingCompletionKey, registerTools } from "./catalog";
import { createSwarmCliRunner } from "./cli";
import { COMPACTION_HOOK_NAME, buildCompactionContribution } from "./compaction";
import { resolveWorkerProtocol } from "./roster";
import { DEFAULT_WORKER_PROTOCOL } from "./worker-protocol-default";
import { createSessionEventWriter } from "./session-events";
import { TOKEN_PRESSURE_HOOK_NAME, createTokenWatchdog } from "./token-watchdog";
import {
  extractCellMarker,
  gateBefore,
  settleAfter,
  type DispatchAfterEvent,
  type DispatchBeforeEvent,
} from "./dispatch";
import {
  bindWorkerAttemptSession,
  createMissionStateStore,
  listAssignments,
  listAttempts,
  readMission,
  selectPendingOrphans,
  type MissionStorageLike,
} from "./state";
import type { DispatchAgentInfo, DispatchAgentList, SwarmxRuntime, ToolContextLike } from "./types";

function isSwarmCliToolCommand(command: string): boolean {
  const decoded = command.replace(/\\x([0-9a-f]{2})/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
    .replace(/\\U([0-9a-f]{8})/g, (escape: string, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
    })
    .replace(/\\u([0-9a-f]{4})/g, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\([0-7]{1,3})/g, (_escape, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  const unquoted = decoded
    .replace(/\\\r?\n/g, "")
    .replace(/["'`]/g, "")
    .replace(/\\([^\r\n])/g, "$1")
    .toLowerCase();
  const expandedPrintfs = unquoted.replace(/\$\(\s*printf\s+(?:%s)+\s+([^)]*)\)/gi, (_match, values: string) =>
    values.replace(/\s+/g, ""),
  );
  const assignments = new Map<string, string>();
  for (const match of expandedPrintfs.matchAll(/(?:^|[\s;&|])([a-z_][a-z0-9_]*)=([^\s;&|]+)/gi)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) assignments.set(name, value);
  }
  let expandedAssignments = expandedPrintfs;
  for (let pass = 0; pass < 3; pass += 1) {
    expandedAssignments = expandedAssignments.replace(
      /\$\{([a-z_][a-z0-9_]*)\}|\$([a-z_][a-z0-9_]*)/gi,
      (reference, braced: string | undefined, plain: string | undefined) =>
        assignments.get(braced ?? plain ?? "") ?? reference,
    );
  }
  const candidates = [
    unquoted,
    expandedPrintfs,
    expandedAssignments,
    unquoted.replace(/\$\([^)]*\)/g, ""),
    expandedPrintfs.replace(/\$\([^)]*\)/g, ""),
    expandedAssignments.replace(/\$\([^)]*\)/g, ""),
  ];

  return candidates.some((candidate) => {
    const variableExpansion = /\$\{[^{}]*\}|\$[a-z_][a-z0-9_]*/gi;
    const variants = [
      candidate,
      candidate.replace(variableExpansion, ""),
      candidate.replace(variableExpansion, " "),
    ];
    return variants.some((expandedVariables) => {
      const shellTokens = expandedVariables.match(/[^\s;&|]+/g) ?? [];
      const wordTokens = expandedVariables.match(/[a-z0-9_@.+/-]+(?:=[a-z0-9_@.+/-]*)?/gi) ?? [];
      const tokens = [
        ...shellTokens.map((token) => token.replace(/^[()[\]{}.,]+|[()[\]{}.,]+$/g, "")),
        ...wordTokens,
      ];
      const globMatchesSwarm = (pattern: string): boolean => {
        let expression = "^";
        for (let index = 0; index < pattern.length; index += 1) {
          const character = pattern[index] ?? "";
          if (character === "*") expression += ".*";
          else if (character === "?") expression += ".";
          else if (character === "[") {
            const end = pattern.indexOf("]", index + 1);
            if (end === -1) return false;
            const contents = pattern.slice(index + 1, end);
            expression += `[${contents.startsWith("!") ? `^${contents.slice(1)}` : contents}]`;
            index = end;
          } else {
            expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          }
        }
        return new RegExp(`${expression}$`, "i").test("swarm");
      };
      const isSwarmExecutable = (token: string): boolean => {
        const basename = token.split("=").at(-1)?.split("/").at(-1) ?? "";
        return basename === "swarm" || globMatchesSwarm(basename);
      };
      const isSwarmCliEntrypoint = (token: string): boolean =>
        isSwarmExecutable(token) ||
        /(?:^|\/)swarm\.(?:js|mjs|cjs)$/.test(token) ||
        token.includes("opencode-swarm-plugin");
      const hasBraceExpansion = /\{[^{}]*(?:\.\.|,)[^{}]*\}/.test(expandedVariables);
      return (
        tokens.some(isSwarmCliEntrypoint) &&
        (tokens.includes("tool") || hasBraceExpansion)
      );
    });
  });
}

type WorkerMutationDenial = "mission_inactive" | "pending_completion" | "token_missing" | "revoked" | "not_owner" | "read_only_followup";

async function workerMutationDenial(
  runtime: SwarmxRuntime,
  sessionID: string,
  agentID: string | undefined,
): Promise<WorkerMutationDenial | undefined> {
  if (runtime.listAgents === undefined) return "token_missing";
  let caller: { readonly mode: string } | undefined;
  try {
    const listed = await runtime.listAgents();
    const agents: readonly DispatchAgentInfo[] = Array.isArray(listed)
      ? (listed as readonly DispatchAgentInfo[])
      : (listed as { readonly data: readonly DispatchAgentInfo[] }).data;
    caller = agents.find((agent: DispatchAgentInfo) => agent.id === agentID);
  } catch {
    return "token_missing";
  }
  if (caller === undefined) return "token_missing";
  if (caller.mode === "primary") return undefined;
  if (
    runtime.store === undefined ||
    runtime.projectID === undefined ||
    runtime.resolveWorkerParentSession === undefined ||
    runtime.resolveWorkerCell === undefined
  ) {
    return "token_missing";
  }
  let parentSessionID: string | null | undefined;
  let marker;
  try {
    [parentSessionID, marker] = await Promise.all([
      runtime.resolveWorkerParentSession(sessionID),
      runtime.resolveWorkerCell(sessionID),
    ]);
  } catch {
    return "token_missing";
  }
  if (parentSessionID === null) return caller.mode !== "all" ? "token_missing" : undefined;
  if (parentSessionID === undefined) return "token_missing";
  let mission;
  try {
    mission = await readMission(runtime.store, runtime.projectID, parentSessionID);
  } catch {
    return "token_missing";
  }
  if (mission === undefined) return undefined;
  if (!mission.active) return marker !== undefined ? "mission_inactive" : undefined;
  if (marker?.dispatchToken === undefined || agentID === undefined) return "token_missing";
  let binding;
  try {
    binding = await bindWorkerAttemptSession(
      runtime.store,
      runtime.projectID,
      parentSessionID,
      sessionID,
      marker,
      agentID,
    );
  } catch {
    return "token_missing";
  }
  if (binding.status === "not_owner") return "not_owner";
  if (binding.status === "revoked") return "revoked";
  if (binding.status === "inactive") return "mission_inactive";
  if (binding.status !== "bound" && binding.status !== "already_bound") return "token_missing";
  const attempt = binding.attempt;
  if (attempt.followup === true) return "read_only_followup";
  const pending = await runtime.store.storage.get(pendingCompletionKey(runtime.projectID, marker.cellID));
  const pendingRecord =
    typeof pending === "object" && pending !== null ? (pending as Record<string, unknown>) : undefined;
  return pendingRecord?.projectID === runtime.projectID &&
    pendingRecord.parentSessionID === parentSessionID &&
    pendingRecord.missionID === binding.missionID &&
    pendingRecord.taskID === marker.cellID
    ? "pending_completion"
    : undefined;
}

/** Optional seams, used by tests to prove the compaction hook calls no CLI. */
export interface SwarmxPluginOverrides {
  /**
   * Runtime overrides merged over the production runtime (CLI runner, roster,
   * store, project/session identity). The store/project bindings stay
   * authoritative for the compaction path, which reads them directly.
   */
  readonly runtime?: Partial<SwarmxRuntime>;
}

/**
 * Builds the plugin definition.
 *
 * @param overrides - optional runtime overrides (tests); production uses the
 * default export.
 */
export function createSwarmxPlugin(overrides: SwarmxPluginOverrides = {}) {
  return Plugin.define({
    id: "swarmx",

    async setup(ctx: Plugin.Context) {
      const projectID = ctx.location.project.id;
      const store = createMissionStateStore(ctx.storage as unknown as MissionStorageLike, {
        projectID,
        listAgents: () => ctx.agent.list() as unknown as Promise<DispatchAgentList>,
      });
      const skills = await ctx.skill.list().catch(() => undefined);
      const catalogProtocol = skills?.data.find((skill) => skill.id === "swarm-worker-protocol")?.content;
      // Fall back to the bundled protocol so workers always receive the survival
      // checklist even when the host does not expose the skill via ctx.skill.list().
      const workerProtocol = resolveWorkerProtocol(
        typeof catalogProtocol === "string" ? catalogProtocol : DEFAULT_WORKER_PROTOCOL,
      );

      // Session id fallback: local tool handlers prefer their per-call context,
      // but the `execute.before` hook already carries the session for hosts that
      // only expose it there.
      let activeSessionID: string | undefined;
      const runtime: SwarmxRuntime = {
        ...createSwarmCliRunner(),
        listAgents: () => ctx.agent.list() as unknown as Promise<DispatchAgentList>,
        resolveWorkerCell: async (sessionID) => {
          const messages = await ctx.session.context({ sessionID });
          const firstUser = messages.find((message) => message.type === "user");
          if (firstUser === undefined) return undefined;
          try {
            return extractCellMarker({ prompt: firstUser.text });
          } catch {
            return undefined;
          }
        },
        resolveWorkerParentSession: async (sessionID) => {
          try {
            return (await ctx.session.get({ sessionID })).parentID ?? null;
          } catch {
            return undefined;
          }
        },
        store,
        projectID,
        projectPath: ctx.location.project.canonical,
        sessionID: () => activeSessionID,
        workerProtocol,
        sessionEvents: createSessionEventWriter(),
        ...overrides.runtime,
      };

      await ctx.permission.hook("evaluate", async (event) => {
        if (
          event.action === "shell" &&
          event.resources.some(isSwarmCliToolCommand)
        ) {
          event.effect = "deny";
          event.message = "Use the swarmx plugin tools; direct swarm CLI calls bypass mission gates.";
          return;
        }
        if (["edit", "write", "patch", "shell"].includes(event.action)) {
          const reason = await workerMutationDenial(runtime, event.sessionID, event.agent);
          if (reason === undefined) return;
          event.effect = "deny";
          event.message = `worker dispatch capability is revoked, unbound, or not owned by this session (${reason}).`;
        }
      });

      // Structural bridge: `Plugin.Context` is nominal (Effect schemas), while
      // the catalogue only needs the synchronous `tool.transform` surface.
      await registerTools(ctx as unknown as ToolContextLike, runtime);

      const before = (event: {
        tool: string;
        sessionID: string;
        agent: string;
        messageID: string;
        id: string;
        input: unknown;
      }): DispatchBeforeEvent => ({
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        messageID: event.messageID,
        id: event.id,
        input: event.input,
      });

      await ctx.tool.hook("execute.before", async (event) => {
        activeSessionID = event.sessionID;
        await gateBefore(store, before(event));
      });

      await ctx.tool.hook("execute.after", async (event) => {
        const base = before(event);
        const settled: DispatchAfterEvent =
          event.status === "completed"
            ? { ...base, status: "completed", result: event.result }
            : { ...base, status: "error", error: event.error };
        await settleAfter(store, settled);
      });

      // Context-pressure watchdog: before every model request, read the
      // coordinator's cumulative input tokens and append at most one advisory
      // system part per threshold. Non-fatal by construction: any failure
      // (session lookup, unexpected payload) is swallowed and never blocks or
      // alters the request beyond the advisory text.
      const tokenWatchdog = createTokenWatchdog();
      await ctx.session.hook(TOKEN_PRESSURE_HOOK_NAME, async (event) => {
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID });
          // Worker (child) sessions have a parent; only the root coordinator is
          // monitored. `null` is treated as a verified root.
          if (session.parentID !== undefined && session.parentID !== null) return;
          const inputTokens = session.tokens?.input;
          if (typeof inputTokens !== "number") return;
          const notice = tokenWatchdog.evaluate(event.sessionID, inputTokens);
          if (notice === undefined) return;
          event.system.push({ type: "text", text: notice.text });
        } catch {
          // A watchdog must never fail the host request.
        }
      });

      // Compaction hook: read-only projection of the mission, pushed as facts.
      // `event.result` is deliberately never assigned — doing so would skip the
      // host model compaction. Any failure is a silent no-op (never a throw,
      // never a log: the state may contain user data).
      await ctx.session.hook(COMPACTION_HOOK_NAME, async (event) => {
        try {
          const mission = await readMission(store, projectID, event.sessionID);
          const [attempts, assignments] = await Promise.all([
            listAttempts(store, projectID, event.sessionID, mission),
            listAssignments(store, projectID),
          ]);
          const contribution = buildCompactionContribution(mission, {
            attempts,
            assignments,
            pendingOrphans: selectPendingOrphans(attempts).length,
          });
          if (contribution === undefined) return;
          event.system.push({ type: "text", text: contribution.text });
        } catch {
          // A compaction hook must never fail the host request.
        }
      });
    },
  });
}

export default createSwarmxPlugin();
