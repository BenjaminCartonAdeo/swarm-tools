/**
 * Shared types for the swarmx V2 plugin.
 *
 * These are the seams between modules: the CLI adapter (`cli.ts`), mission
 * state (`state.ts`), dispatch gates (`dispatch.ts`), roster resolution
 * (`roster.ts`) and compaction (`compaction.ts`). Task 1 only freezes the
 * contracts; behaviour lands in Tasks 2-6.
 */

import type { SessionEventSink } from "./session-events";
import type { MissionStateStore } from "./state";

/** JSON-serialisable value, aligned with plugin storage's `Schema.Json`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** ISO-8601 timestamp (e.g. `2026-11-12T09:00:00.000Z`). */
export type IsoTimestamp = string;

/** Thrown by scaffold stubs until the owning task implements them. */
export class NotImplementedError extends Error {
  /**
   * @param area - module/feature that is not implemented yet (e.g. `"cli"`).
   */
  constructor(area: string) {
    super(`swarmx: ${area} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/**
 * Machine-readable CLI failure codes.
 *
 * Every code maps to one actionable failure mode of the `swarm` binary:
 * missing executable, deadline, non-zero exit, unparsable output, output
 * ceiling and caller cancellation.
 */
export type CliErrorCode =
  | "CliNotFound"
  | "CliTimeout"
  | "CliNonZero"
  | "CliInvalidJson"
  | "CliOutputTooLarge"
  | "CliAborted";

/**
 * Per-invocation CLI options.
 *
 * `binary` overrides the executable (falling back to `$SWARMX_SWARM_BIN`, then
 * `"swarm"`); `env` is merged over the inherited environment and is the only
 * way callers can add variables — the adapter never exposes `process.env`.
 */
export interface RunToolOptions {
  /** Executable name or absolute path. */
  readonly binary?: string;
  /** Working directory for the child process. */
  readonly cwd?: string;
  /** Cancels the child process (SIGKILL) and rejects with `CliAborted`. */
  readonly signal?: AbortSignal;
  /** Hard deadline per invocation, in milliseconds. Defaults to 30 000. */
  readonly timeoutMs?: number;
  /** Ceiling for cumulative stdout + stderr bytes. Defaults to 1 000 000. */
  readonly maxBytes?: number;
  /** Extra environment variables merged over `process.env` for the child. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Boundary around the `swarm` CLI so tests can inject a fake runner.
 *
 * Implemented in Task 2 (`cli.ts`).
 */
export interface SwarmCliRunner {
  /** Runs one backend tool and returns its parsed JSON payload. */
  runTool(name: string, args: Record<string, unknown>, opts?: RunToolOptions): Promise<unknown>;
  /** Lists the backend tool names exposed by `swarm tool --list`. */
  listTools(opts?: RunToolOptions): Promise<string[]>;
  /** Returns the semantic version reported by `swarm --version`. */
  version(opts?: RunToolOptions): Promise<string>;
}

/** Where a tool executes: forwarded to the CLI or handled in-process. */
export type ToolKind = "backend" | "local";

/**
 * Compatibility status of a tool.
 *
 * - `active`: exposed and routable as declared.
 * - `alias`: same contract as `backendName`, forwarded there.
 * - `deprecated`: V1 name with no compatible backend; `execute` always rejects.
 */
export type ToolStatus = "active" | "alias" | "deprecated";

/**
 * One exposed plugin tool.
 *
 * `inputSchema` is a JSON Schema object (`type: "object"`, `properties`,
 * optional `required`, `additionalProperties`). Backend and alias specs carry
 * a `backendName`; deprecated specs carry an actionable `deprecatedReason`.
 */
export interface ToolSpec {
  /** Effective tool name, identical to the V1 name. */
  name: string;
  /** Faithful copy of the V1 tool description. */
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  status: ToolStatus;
  /** CLI tool receiving the call. Required when `kind === "backend"`. */
  backendName?: string;
  /** Cause and replacement. Required when `status === "deprecated"`. */
  deprecatedReason?: string;
}

/** Shape returned by a tool handler (mirrors the V2 `Tool.Result` subset). */
export interface ToolExecuteResult {
  output?: unknown;
  content?: unknown;
  metadata?: unknown;
}

/** V2 tool handler signature: `execute(input, ctx)`. */
export type ToolExecuteHandler = (
  input: unknown,
  context: unknown,
) => Promise<ToolExecuteResult>;

/** Minimal tool definition accepted by a V2 tool editor. */
export interface ToolRegistration {
  name: string;
  description: string;
  input: Record<string, unknown>;
  /**
   * Declared output schema. Mandatory in practice: V2 rejects any result that
   * carries an `output` field when the registration declares none
   * (`Tool result declared output without an output schema`).
   */
  output?: unknown;
  execute: ToolExecuteHandler;
}

/** Minimal V2 tool editor: registration only (list/get are not needed here). */
export interface ToolEditorLike {
  add(tool: ToolRegistration): void;
}

/**
 * Narrow structural view of `Plugin.Context` used by the catalogue.
 *
 * The real context is nominal (Effect schemas); callers bridge with a
 * documented `as unknown as ToolContextLike` cast, exactly like the test
 * helpers bridge the fake context to `Plugin.Context`.
 */
export interface ToolContextLike {
  readonly tool: {
    transform(callback: (editor: ToolEditorLike) => void): Promise<unknown>;
  };
  readonly permission: {
    assert(input: ToolPermissionAssertion): Promise<void>;
  };
}

/** Custom permission assertion forwarded to OpenCode for an in-process tool. */
export interface ToolPermissionAssertion {
  readonly sessionID: string;
  readonly agent: string;
  readonly source: { readonly type: "tool"; readonly messageID: string; readonly id: string };
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
}

/**
 * Injectable execution boundary for backend tools and local tool dependencies.
 *
 * Production wires `createSwarmCliRunner()` (`cli.ts`) plus the mission store, the
 * roster reader and the project/session identity (`index.ts`); tests inject fakes.
 * Every extra field is optional so a CLI-only runtime stays valid — a local tool
 * that needs a missing dependency throws a typed {@link LocalToolError} instead of
 * faking success.
 */
export interface SwarmxRuntime {
  runTool(name: string, args: Record<string, unknown>, options?: RunToolOptions): Promise<unknown>;
  /** Roster reader for local tools (production: `ctx.agent.list()`). */
  listAgents?: () => Promise<DispatchAgentList>;
  /** Cell marker parsed from a subagent session's initial task prompt. */
  resolveWorkerCell?: (sessionID: string) => Promise<CellMarker | undefined>;
  /** Parent session recorded by OpenCode for the actual worker session. */
  resolveWorkerParentSession?: (sessionID: string) => Promise<string | null | undefined>;
  /** Mission store backing budget/finish/audit/assignments. */
  store?: MissionStateStore;
  /** Project id bound to the mission documents (production: `location.project.id`). */
  projectID?: string;
  /** Canonical project root used to constrain scoped review tools. */
  projectPath?: string;
  /**
   * Session id fallback. Handlers prefer the per-call `context.sessionID`; this
   * provider covers hosts that only expose the session through hooks.
   */
  sessionID?: string | (() => string | undefined);
  /**
   * Worker protocol text injected by `swarm_subtask_prompt`. Absent or blank
   * resolves to the fail-closed load-or-stop instruction, never to an
   * unguarded prompt.
   */
  workerProtocol?: string;
  /**
   * Sink for coordinator session events (VIOLATION).
   *
   * Production appends to `$SWARM_SESSIONS_DIR/<session>.jsonl`; when absent
   * (bare test runtimes) violation capture is a silent no-op.
   */
  sessionEvents?: SessionEventSink;
}

/** Machine-readable local tool failure codes. */
export type LocalToolErrorCode =
  | "invalid_input"
  | "runtime_unavailable"
  | "not_found"
  | "conflict"
  | "agent_unknown"
  | "agent_not_dispatchable"
  | "protocol_injection_invalid";

/**
 * Explicit failure raised by a local tool handler.
 *
 * The message always carries the effective tool name so the model can correct
 * course, and never contains arguments, prompts or environment.
 */
export class LocalToolError extends Error {
  readonly tool: string;
  readonly code: LocalToolErrorCode;

  /**
   * @param tool - effective tool name (e.g. `swarm_roster`).
   * @param code - machine-readable failure family.
   * @param detail - actionable context (validated ids, ceiling, replacement).
   */
  constructor(tool: string, code: LocalToolErrorCode, detail: string) {
    super(`swarmx ${tool} failed [${code}]: ${detail}`);
    this.name = "LocalToolError";
    this.tool = tool;
    this.code = code;
  }
}

/** Structural view of the per-call `execute(input, context)` payload. */
export interface ToolExecuteContextLike {
  readonly sessionID?: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
}

/** Explicit failure for a V1 tool that cannot be served any more. */
export class UnsupportedToolError extends Error {
  readonly tool: string;
  readonly reason: string;

  /**
   * @param tool - V1 tool name that is no longer supported.
   * @param reason - cause plus the replacement tool.
   */
  constructor(tool: string, reason: string) {
    super(`unsupported_tool:${tool} — ${reason}`);
    this.name = "UnsupportedToolError";
    this.tool = tool;
    this.reason = reason;
  }
}

export type MissionStatus = "idle" | "planning" | "dispatching" | "review" | "done" | "failed";

export type MissionTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed";

/** One decomposed unit of work tracked by a mission. */
export interface MissionTask {
  readonly id: string;
  readonly title: string;
  readonly files: readonly string[];
  readonly agent?: string;
  status: MissionTaskStatus;
}

/** Execution mode of a mission: read-only audit vs. implementation. */
export type MissionMode = "audit" | "dev";

/**
 * Hard ceilings for one mission.
 *
 * `workerShare` caps the proportion of spawns granted to the generic
 * `swarm-worker` agent (defaults to `DEFAULT_WORKER_SHARE`, i.e. 0.2).
 */
export interface MissionBudget {
  maxSpawns: number;
  maxIterations: number;
  workerShare?: number;
}

/** Ledger counters kept in sync with the dispatch attempts. */
export interface MissionCounts {
  spawns: number;
  cells: number;
  attemptsByCell: Record<string, number>;
  workerSpawns: number;
}

/**
 * Root-cause payload required before a retry prompt is generated.
 *
 * At least one field must be non-empty: a retry without a cause repeats the
 * failed attempt instead of correcting it.
 */
export interface RetryRootCause {
  /** What actually failed, in one or two sentences. */
  readonly failureReason?: string;
  /** Exact command that produced the failure. */
  readonly failedCommand?: string;
  /** Relevant stderr/stdout extract. */
  readonly errorExcerpt?: string;
}

/** One persisted retry cause, kept on the mission for audit. */
export interface RetryCauseRecord extends RetryRootCause {
  readonly cellID: string;
  readonly epicID: string;
  readonly attempt: number;
  readonly ts: IsoTimestamp;
}

/** Lifecycle of the epic consolidation cell prepared by the plugin. */
export type ConsolidationStatus = "pending" | "ready" | "dispatched" | "completed";

/**
 * Pointer to the consolidation cell of one epic.
 *
 * The plugin cannot spawn a subagent: it prepares the cell, assigns it and
 * stores the generated prompt here. The coordinator dispatches it.
 */
export interface ConsolidationState {
  /** Epic whose cells are being consolidated. */
  epicID: string;
  /** Consolidation cell created (or reserved) for this epic. */
  cellID: string;
  status: ConsolidationStatus;
  /** Prompt handed to the coordinator when dispatching the cell. */
  prompt?: string;
  createdAt: number;
}

/**
 * Persisted mission state.
 *
 * One active document per `(project, session)` pair, stored under
 * `mission:<project>:<session>`. `missionID` distinguishes restarts in the same
 * session; it is absent only on legacy documents written before generation scoping.
 */
export interface MissionState {
  /** Unique generation; omitted only for missions persisted before V2 generation scoping. */
  missionID?: string;
  projectID: string;
  sessionID: string;
  active: boolean;
  mode: MissionMode;
  budget: MissionBudget;
  counts: MissionCounts;
  /** Retry root causes recorded by `swarm_spawn_retry`, oldest first. */
  retryCauses?: RetryCauseRecord[];
  /** Consolidation cell of the active epic, once prepared. */
  consolidation?: ConsolidationState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Lifecycle of one `subagent` tool call. */
export type DispatchAttemptStatus = "pending" | "succeeded" | "failed" | "aborted";

/**
 * One entry of the idempotent dispatch ledger.
 *
 * Indexed by `callID` (the host's `Tool.CallID`) and associated with one
 * mission generation. `pending` means the `execute.before` reservation happened;
 * `aborted` is set by orphan recovery (see `state.ts`).
 */
export interface DispatchAttempt {
  callID: string;
  /** Mission generation; omitted only for legacy ledger entries. */
  missionID?: string;
  sessionID: string;
  cellID: string;
  epicID?: string;
  agent: string;
  status: DispatchAttemptStatus;
  ts: IsoTimestamp;
  /** One-use capability injected into the dispatched prompt by the execute.before hook. */
  dispatchToken?: string;
  /** V2 child session bound on its first scoped worker tool call. */
  workerSessionID?: string;
  /** Set after review feedback or finalization revokes this worker attempt. */
  revokedAt?: IsoTimestamp;
}

/** Why a dispatch was refused. Machine-readable, surfaced to the model. */
export type GateReason =
  | "mission_inactive"
  | "mission_changed"
  | "not_dispatch_tool"
  | "cell_marker_missing"
  | "cell_marker_malformed"
  | "dispatch_token_missing"
  | "dispatch_token_reused"
  | "agent_missing"
  | "agent_unknown"
  | "agent_not_dispatchable"
  | "caller_not_coordinator"
  | "cleanup_in_progress"
  | "call_id_conflict"
  | "cell_not_assigned"
  | "assignment_mismatch"
  | "budget_exhausted"
  | "cell_iterations_exhausted"
  | "worker_share_exceeded";

/**
 * Refusal raised by `execute.before`.
 *
 * The host turns a rejected `execute.before` into a `Tool.Error`, so the model
 * sees the message and can correct course. Messages carry the reason, the cell
 * and the ceiling involved — never the prompt, arguments or environment.
 */
export class DispatchGateError extends Error {
  readonly reason: GateReason;
  readonly cellID?: string;
  readonly detail?: string;

  /**
   * @param reason - machine-readable refusal cause.
   * @param cellID - cell concerned, when the gate is cell-scoped.
   * @param detail - actionable cap/assignment context (never a raw prompt).
   */
  constructor(reason: GateReason, cellID?: string, detail?: string) {
    super(formatGateMessage(reason, cellID, detail));
    this.name = "DispatchGateError";
    this.reason = reason;
    this.cellID = cellID;
    this.detail = detail;
  }
}

const GATE_REASON_MESSAGES: Readonly<Record<GateReason, string>> = {
  mission_inactive: "no active swarmx mission for this session",
  mission_changed: "the swarmx mission changed while the dispatch was being validated",
  not_dispatch_tool: "the tool is not the swarmx dispatch tool",
  cell_marker_missing:
    "dispatch prompt is missing the swarmx cell marker <!-- swarmx:cell=<id>; epic=<id> -->",
  cell_marker_malformed:
    "swarmx cell marker must appear exactly once as <!-- swarmx:cell=<id>; epic=<id> -->",
  dispatch_token_missing: "dispatch must use the exact prompt produced by swarm_subtask_prompt",
  dispatch_token_reused: "this prompt capability was already used for another dispatch",
  agent_missing: "the subagent input must include a target agent ID",
  agent_unknown: "the dispatched agent is not in the roster (no fallback agent is applied)",
  agent_not_dispatchable: "the dispatched agent is hidden or primary and cannot receive subtasks",
  caller_not_coordinator: "only the canonical primary swarm coordinator may dispatch subagents",
  cleanup_in_progress: "a worktree cleanup is in progress for this project or cell",
  call_id_conflict: "the tool call ID belongs to a different mission generation",
  cell_not_assigned: "the cell has no recorded agent assignment; run swarm_set_agent first",
  assignment_mismatch: "the dispatched agent does not match the recorded cell assignment",
  budget_exhausted: "the mission spawn budget is exhausted",
  cell_iterations_exhausted: "the per-cell iteration budget is exhausted",
  worker_share_exceeded: "the swarm-worker share of spawns would exceed the mission ceiling",
};

function formatGateMessage(reason: GateReason, cellID?: string, detail?: string): string {
  const parts = [`swarmx dispatch refused [${reason}]: ${GATE_REASON_MESSAGES[reason]}`];
  if (cellID !== undefined) parts.push(`cell=${cellID}`);
  if (detail !== undefined) parts.push(detail);
  return parts.join(" — ");
}

/** Agent fields the dispatch gate needs (subset of `ctx.agent.list()`). */
export interface DispatchAgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
}

/**
 * Roster shape returned by `ctx.agent.list()`.
 *
 * The V2 client wraps the payload in `{ data: [...] }`; the test fake returns a
 * plain array. Both are accepted and normalized by the gate.
 */
export type DispatchAgentList =
  | readonly DispatchAgentInfo[]
  | { readonly data: readonly DispatchAgentInfo[] };

/** Async roster reader bound to a mission store (defaults to an empty roster). */
export type DispatchAgentLister = () => Promise<DispatchAgentList>;

/** Parsed `<!-- swarmx:cell=<id>; epic=<id> -->` marker. */
export interface CellMarker {
  readonly cellID: string;
  readonly epicID: string;
  readonly dispatchToken?: string;
}

/**
 * Cell status as observed by the audit/compaction selectors.
 *
 * `open` mirrors Hive's ready state; the ledger only knows the mission task
 * statuses, so both are accepted and treated as "dispatchable".
 */
export type MissionCellStatus = MissionTaskStatus | "open";

/**
 * One cell projection shared by `swarm_agent_audit` and the compaction builder.
 *
 * Facts only: identity, bounded title, status, assigned agent and attempt count.
 * `dependsOn` is optional and only used when the caller has a Hive snapshot.
 */
export interface MissionCellSnapshot {
  readonly id: string;
  /** Raw title; compaction truncates it, it is never the full description. */
  readonly title?: string;
  readonly status?: MissionCellStatus;
  readonly agent?: string;
  readonly attempts: number;
  readonly dependsOn?: readonly string[];
  readonly epicID?: string;
}

/** Inputs of the pure `selectCells` selector. */
export interface MissionCellSelectorInput {
  readonly state?: MissionState;
  readonly attempts?: readonly DispatchAttempt[];
  readonly assignments?: Readonly<Record<string, string>>;
  /** Optional Hive snapshot; wins over ledger-derived facts when present. */
  readonly cells?: readonly MissionCellSnapshot[];
}

/** Aggregate mission facts shared by the audit tool and the compaction builder. */
export interface MissionSummary {
  readonly active: boolean;
  readonly mode: MissionMode;
  readonly budget: MissionBudget;
  readonly counts: MissionCounts;
  readonly remainingSpawns: number;
  /**
   * Iterations left for the most advanced cell (`maxIterations` minus the
   * highest per-cell attempt count); `maxIterations` when no cell is tracked.
   */
  readonly remainingIterations: number;
  readonly workerShare: number;
}

/** Structured output of `audit()`. */
export interface MissionAudit {
  readonly active: boolean;
  readonly mode?: MissionMode;
  readonly budget?: MissionBudget;
  readonly counts?: MissionCounts;
  readonly attempts: readonly DispatchAttempt[];
  /** Pending attempts abandoned by a crash and moved to `aborted` by this call. */
  readonly pendingOrphans: number;
  /**
   * Consolidation cell of the active epic, once prepared.
   *
   * Exposed so `swarm_agent_audit` can tell the coordinator that a consolidation
   * prompt is waiting to be dispatched (or that it already ran).
   */
  readonly consolidation?: ConsolidationState;
}
