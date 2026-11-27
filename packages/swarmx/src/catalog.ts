/**
 * Tool catalogue exposed by the swarmx plugin (Task 3).
 *
 * Source of truth: the 81 V1 declarations in `plugins.v1/swarm-dispatch.ts`
 * (name, description, args) and `swarm tool --list` 0.63.2 (117 names).
 * Only metadata is carried over — V1 `execute` bodies are deliberately dropped.
 *
 * Distribution (82 specs):
 *   - 70 backend active (all V1 names present in the 0.63.2 CLI);
 *   - 7 local active (6 V1 dispatch tools + the new `swarm_finish`);
 *   - 4 deprecated (absent from the CLI, no compatible replacement contract);
 *   - 1 proven alias: `beads_link_thread` → `hive_link_thread`.
 *
 * Router: active/alias backend → `runtime.runTool(backendName, args)`;
 * deprecated → `UnsupportedToolError` (`unsupported_tool:<name>`); local →
 * in-process handler (typed `LocalToolError` when a dependency is missing).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  countOccurrences,
  listRoster,
  parseRetryRootCause,
  renderRetryRootCause,
  renderSubtaskPrompt,
  resolveAgent,
  resolveWorkerProtocol,
  RetryCauseError,
  isSwarmWorkerAgentID,
  SWARM_WORKER_AGENT_ID,
  WORKER_PROTOCOL_FALLBACK,
  type RenderPromptInput,
  type RosterAgent,
} from "./roster";
import {
  attachHistorySummary,
  injectHistoryContext,
  queryDecompositionHistory,
} from "./history";
import {
  isConsolidationCellFinished,
  DEFAULT_WORKER_SHARE,
  selectMissionSummary,
  selectReadyCells,
} from "./state";
import { getMission, listMissions, listUnits, MissionConflictError, MissionPolicyValidationError } from "./workunit/mission";
import { projectMission, selectMissionOrphanCandidates } from "./workunit/projection";
import type { Mission, WorkUnit } from "./workunit/schema";
import { effectiveCompletionFiles, MissionNotDrainedError } from "./workunit/store";
import {
  acquireWorkUnitLock,
  CLEANUP_LOCK_STALE_MS,
  cleanupLockName,
  releaseWorkUnitLock,
} from "./workunit/locks";
import { emitDecision, emitViolation } from "./session-events";
import {
  LocalToolError,
  UnsupportedToolError,
  type CellMarker,
  type ConsolidationState,
  type DispatchAgentInfo,
  type DispatchAgentList,
  type DispatchAttempt,
  type MissionCellSnapshot,
  type MissionAudit,
  type MissionMode,
  type MissionState,
  type SwarmxRuntime,
  type ToolContextLike,
  type ToolExecuteContextLike,
  type ToolExecuteResult,
  type ToolPermissionAssertion,
  type ToolSpec,
} from "./types";

type JsonSchema = Record<string, unknown>;
type Properties = Record<string, JsonSchema>;

function withDescription(schema: JsonSchema, description?: string): JsonSchema {
  return description === undefined ? schema : { ...schema, description };
}

/** `string` property with optional JSON Schema constraints (`minLength`, …). */
function str(description?: string, constraints: JsonSchema = {}): JsonSchema {
  return withDescription({ type: "string", ...constraints }, description);
}

/**
 * `number` property with optional JSON Schema constraints (`minimum`, …).
 * `{ integer: true }` maps to the JSON Schema `integer` type.
 */
function num(description?: string, constraints: JsonSchema = {}): JsonSchema {
  const { integer, ...rest } = constraints;
  return withDescription({ type: integer === true ? "integer" : "number", ...rest }, description);
}

/** `boolean` property. */
function bool(description?: string): JsonSchema {
  return withDescription({ type: "boolean" }, description);
}

/** `string` property restricted to a closed enum. */
function enumOf(values: readonly string[], description?: string): JsonSchema {
  return withDescription({ type: "string", enum: [...values] }, description);
}

/** `array` property. */
function arr(items: JsonSchema, description?: string): JsonSchema {
  return withDescription({ type: "array", items }, description);
}

/** Closed nested object (mirrors Zod's default unknown-key stripping). */
function obj(properties: Properties = {}, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

/** Closed tool input schema. */
function inputSchema(properties: Properties = {}, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

function backend(
  name: string,
  description: string,
  properties: Properties = {},
  required: readonly string[] = [],
): ToolSpec {
  return {
    name,
    description,
    inputSchema: inputSchema(properties, required),
    kind: "backend",
    status: "active",
    backendName: name,
  };
}

function alias(
  name: string,
  description: string,
  backendName: string,
  properties: Properties = {},
  required: readonly string[] = [],
): ToolSpec {
  return {
    name,
    description,
    inputSchema: inputSchema(properties, required),
    kind: "backend",
    status: "alias",
    backendName,
  };
}

function local(
  name: string,
  description: string,
  properties: Properties = {},
  required: readonly string[] = [],
): ToolSpec {
  return { name, description, inputSchema: inputSchema(properties, required), kind: "local", status: "active" };
}

function deprecated(
  name: string,
  description: string,
  deprecatedReason: string,
  properties: Properties = {},
  required: readonly string[] = [],
): ToolSpec {
  return {
    name,
    description,
    inputSchema: inputSchema(properties, required),
    kind: "backend",
    status: "deprecated",
    deprecatedReason,
  };
}

const PRIORITY: JsonSchema = { minimum: 0, maximum: 3 };
const CELL_STATUS = ["open", "in_progress", "blocked", "closed"] as const;
const WORK_ITEM_TYPE = ["bug", "feature", "task", "epic", "chore"] as const;

const HIVE_SPECS: readonly ToolSpec[] = [
  backend(
    "hive_create",
    "Create a new bead with type-safe validation",
    {
      title: str("Bead title"),
      type: enumOf(WORK_ITEM_TYPE, "Issue type (default: task)"),
      priority: num("Priority 0-3 (default: 2)", PRIORITY),
      description: str("Bead description"),
      parent_id: str("Parent bead ID for epic children"),
    },
    ["title"],
  ),
  backend(
    "hive_create_epic",
    "Create epic with subtasks in one atomic operation",
    {
      epic_title: str("Epic title"),
      epic_description: str("Epic description"),
      subtasks: arr(
        obj(
          {
            title: str(),
            priority: num(undefined, PRIORITY),
            files: arr(str()),
          },
          ["title"],
        ),
        "Subtasks to create under the epic",
      ),
    },
    ["epic_title", "subtasks"],
  ),
  backend(
    "hive_query",
    "Query beads with filters (replaces bd list, bd ready, bd wip)",
    {
      status: enumOf(CELL_STATUS, "Filter by status"),
      type: enumOf(WORK_ITEM_TYPE, "Filter by type"),
      ready: bool("Only show unblocked beads"),
      limit: num("Max results (default: 20)"),
    },
  ),
  backend(
    "hive_update",
    "Update a cell. Subagents may only set status to in_progress or blocked; coordinators own description, priority, and closure changes.",
    {
      id: str("Cell ID"),
      status: enumOf(CELL_STATUS, "New status"),
      description: str("New description"),
      priority: num("New priority", PRIORITY),
    },
    ["id"],
  ),
  backend(
    "hive_close",
    "Coordinator-only outside active swarmx missions. During a mission, workers close through approved swarm_complete; direct hive_close is refused.",
    { id: str("Cell ID"), reason: str("Completion reason") },
    ["id", "reason"],
  ),
  backend("hive_start", "Mark a bead as in-progress", { id: str("Cell ID") }, ["id"]),
  backend("hive_ready", "Get the next ready bead (unblocked, highest priority)"),
  backend(
    "hive_sync",
    "Coordinator-only: sync beads to git at mission end",
    { auto_pull: bool("Pull before sync") },
  ),
  backend(
    "hive_cells",
    `Query cells from the hive database with flexible filtering.

USE THIS TOOL TO:
- List all open cells: hive_cells()
- Find cells by status: hive_cells({ status: "in_progress" })
- Find cells by type: hive_cells({ type: "bug" })
- Get a specific cell by partial ID: hive_cells({ id: "mjkmd" })
- Get the next ready (unblocked) cell: hive_cells({ ready: true })
- Get children of an epic: hive_cells({ parent_id: "epic-id" })
- Combine filters: hive_cells({ status: "open", type: "task" })
- Query another project: hive_cells({ project_key: "/home/joel/clawd" })

RETURNS: Array of cells with id, title, status, priority, type, parent_id, created_at, updated_at

PREFER THIS OVER hive_query when you need to:
- See what work is available
- Check status of multiple cells
- Find cells matching criteria
- Look up a cell by partial ID`,
    {
      id: str("Partial or full cell ID to look up"),
      status: enumOf(CELL_STATUS, "Filter by status"),
      type: enumOf(["task", "bug", "feature", "epic", "chore"], "Filter by type"),
      parent_id: str("Filter by parent epic ID (returns children of an epic)"),
      ready: bool("If true, return only the next unblocked cell"),
      limit: num("Max cells to return (default 20)"),
      project_key: str("Override project scope (use hive_projects to list available)"),
    },
  ),
  // Proven alias: the CLI package itself declares `beads_link_thread` as
  // `{ ...hive_link_thread }` with the exact same `bead_id`/`thread_id` args.
  alias(
    "beads_link_thread",
    "Add metadata linking bead to Agent Mail thread",
    "hive_link_thread",
    { bead_id: str("Cell ID"), thread_id: str("Agent Mail thread ID") },
    ["bead_id", "thread_id"],
  ),
  backend(
    "hive_session_start",
    `Start a new work session with optional handoff notes from previous session.

Chainlink-inspired session management for context preservation across sessions.
Returns previous session's handoff notes if available.

Credit: Chainlink session handoff pattern from https://github.com/dollspace-gay/chainlink`,
    { active_cell_id: str("ID of cell being worked on") },
  ),
  backend(
    "hive_session_end",
    `End current session with handoff notes for next session.

Save context for the next agent/session to pick up where you left off.
Include: what was done, what's next, any blockers or gotchas.

Credit: Chainlink session handoff pattern from https://github.com/dollspace-gay/chainlink`,
    { handoff_notes: str("Notes for next session (e.g., 'Completed X. Next: do Y. Watch out for Z.')") },
  ),
];

const SWARM_MAIL_SPECS: readonly ToolSpec[] = [
  backend(
    "swarmmail_init",
    "Initialize Swarm Mail session (REQUIRED FIRST)",
    {
      project_path: str("Absolute path to the project"),
      agent_name: str("Custom agent name"),
      task_description: str("Task description"),
    },
    ["project_path"],
  ),
  backend(
    "swarmmail_send",
    "Send message to other agents via Swarm Mail",
    {
      to: arr(str(), "Recipient agent names"),
      subject: str("Message subject"),
      body: str("Message body"),
      thread_id: str("Thread ID for grouping"),
      importance: enumOf(["low", "normal", "high", "urgent"], "Message importance"),
      ack_required: bool("Require acknowledgment"),
    },
    ["to", "subject", "body"],
  ),
  backend(
    "swarmmail_inbox",
    "Fetch inbox (CONTEXT-SAFE: bodies excluded, max 5 messages)",
    {
      limit: num("Max messages (max 5)", { maximum: 5 }),
      urgent_only: bool("Only urgent messages"),
    },
  ),
  backend(
    "swarmmail_read_message",
    "Fetch ONE message body by ID",
    { message_id: num("Message ID") },
    ["message_id"],
  ),
  backend(
    "swarmmail_reserve",
    "Reserve file paths for exclusive editing",
    {
      paths: arr(str(), "File paths/patterns"),
      ttl_seconds: num("Reservation TTL"),
      exclusive: bool("Exclusive lock"),
      reason: str("Reservation reason"),
    },
    ["paths"],
  ),
  backend(
    "swarmmail_release",
    "Release file reservations",
    {
      paths: arr(str(), "Paths to release"),
      reservation_ids: arr(num(), "Reservation IDs"),
    },
  ),
  backend("swarmmail_release_all", "Coordinator-only: release all file reservations in the project (override)"),
  backend(
    "swarmmail_release_agent",
    "Coordinator-only: release all file reservations for a specific agent (override)",
    { agent_name: str("Target agent name") },
    ["agent_name"],
  ),
  backend("swarmmail_ack", "Acknowledge a message", { message_id: num("Message ID") }, ["message_id"]),
  backend("swarmmail_health", "Check Swarm Mail database health"),
];

const STRUCTURED_SPECS: readonly ToolSpec[] = [
  backend("structured_extract_json", "Extract JSON from markdown/text response", { text: str("Text containing JSON") }, [
    "text",
  ]),
  backend(
    "structured_validate",
    "Validate agent response against a schema",
    {
      response: str("Agent response to validate"),
      schema_name: enumOf(["evaluation", "task_decomposition", "cell_tree"], "Schema to validate against"),
      max_retries: num("Max retries", { minimum: 1, maximum: 5 }),
    },
    ["response", "schema_name"],
  ),
  backend("structured_parse_evaluation", "Parse and validate evaluation response", { response: str("Agent response") }, [
    "response",
  ]),
  backend(
    "structured_parse_decomposition",
    "Parse and validate task decomposition response",
    { response: str("Agent response") },
    ["response"],
  ),
  backend("structured_parse_cell_tree", "Parse and validate bead tree response", { response: str("Agent response") }, [
    "response",
  ]),
];

const SWARM_SPECS: readonly ToolSpec[] = [
  backend(
    "swarm_init",
    "Initialize swarm session and check tool availability",
    {
      project_path: str("Project path"),
      isolation: enumOf(
        ["worktree", "reservation"],
        "Isolation mode: 'worktree' for git worktree isolation, 'reservation' for file reservations (default)",
      ),
    },
  ),
  backend(
    "swarm_select_strategy",
    "Analyze task and recommend decomposition strategy",
    {
      task: str("Task to analyze", { minLength: 1 }),
      codebase_context: str("Codebase context"),
    },
    ["task"],
  ),
  backend(
    "swarm_plan_prompt",
    "Generate strategy-specific decomposition prompt",
    {
      task: str("Task to decompose", { minLength: 1 }),
      strategy: enumOf(["file-based", "feature-based", "risk-based", "auto"], "Decomposition strategy"),
      max_subtasks: num("Max subtasks", { integer: true, minimum: 2, maximum: 10 }),
      context: str("Additional context"),
      query_cass: bool("Query CASS for similar tasks"),
      cass_limit: num("CASS limit", { integer: true, minimum: 1, maximum: 10 }),
    },
    ["task"],
  ),
  backend(
    "swarm_decompose",
    "Generate decomposition prompt for breaking task into subtasks",
    {
      task: str("Task to decompose", { minLength: 1 }),
      max_subtasks: num("Max subtasks", { integer: true, minimum: 2, maximum: 10 }),
      context: str("Additional context"),
      query_cass: bool("Query CASS"),
      cass_limit: num("CASS limit", { integer: true, minimum: 1, maximum: 10 }),
    },
    ["task"],
  ),
  backend(
    "swarm_validate_decomposition",
    "Validate a decomposition response against CellTreeSchema",
    { response: str("Decomposition response") },
    ["response"],
  ),
  backend(
    "swarm_status",
    "Get status of a swarm by epic ID",
    { epic_id: str("Epic bead ID"), project_key: str("Project key") },
    ["epic_id", "project_key"],
  ),
  backend(
    "swarm_progress",
    "Report progress on a subtask to coordinator. Terminal statuses (completed/failed) are refused: use swarm_complete to submit a completion for review.",
    {
      project_key: str("Project key"),
      agent_name: str("Agent name"),
      bead_id: str("Cell ID"),
      status: enumOf(["in_progress", "blocked", "completed", "failed"], "Status"),
      message: str("Progress message"),
      progress_percent: num("Progress %", { minimum: 0, maximum: 100 }),
      files_touched: arr(str(), "Files modified"),
    },
    ["project_key", "agent_name", "bead_id", "status"],
  ),
  backend(
    "swarm_complete",
    "Submit a worker's completion for coordinator review. files_touched may be empty for no-file tasks (research, analysis); start_time is optional and defaults to the submission time. swarmx runs the verification gate and finalizes only after an approved scoped review. Skip flags are rejected.",
    {
      project_key: str("Project key"),
      agent_name: str("Agent name"),
      bead_id: str("Cell ID"),
      summary: str("Completion summary", { minLength: 1 }),
      evaluation: str("Self-evaluation JSON"),
      files_touched: withDescription(
        { type: "array", items: str(), minItems: 0 },
        "List of changed file paths (may be empty for no-file tasks); these paths will be verified",
      ),
      start_time: num(
        "Optional task start timestamp in Unix milliseconds; defaults to the submission time",
        { integer: true, minimum: 0 },
      ),
      verification: arr(
        obj({
          name: str("Verification step name"),
          command: str("Command executed"),
          exit_code: num("Process exit code", { integer: true }),
          output: str("Command output"),
        }, ["name", "command", "exit_code", "output"]),
        "Optional verification commands/results; all steps must pass to produce a receipt",
      ),
      skip_verification: bool("Legacy override; swarmx rejects true and always requires verification"),
      skip_review: bool("Legacy override; swarmx rejects true and always requires coordinator review"),
    },
    ["project_key", "agent_name", "bead_id", "summary"],
  ),
  backend(
    "swarm_record_outcome",
    "Record subtask outcome for implicit feedback scoring",
    {
      bead_id: str("Cell ID"),
      duration_ms: num("Duration in ms", { integer: true, minimum: 0 }),
      error_count: num("Error count", { integer: true, minimum: 0 }),
      retry_count: num("Retry count", { integer: true, minimum: 0 }),
      success: bool("Whether task succeeded"),
      files_touched: arr(str(), "Files modified"),
      criteria: arr(str(), "Evaluation criteria"),
      strategy: enumOf(["file-based", "feature-based", "risk-based"], "Strategy used"),
    },
    ["bead_id", "duration_ms", "success"],
  ),
  backend(
    "swarm_spawn_subtask",
    "Generate a subtask prompt. It does not spawn the worker; dispatch with the V2 subagent tool using the assigned agent ID and cell marker.",
    {
      bead_id: str("Cell ID"),
      epic_id: str("Epic ID"),
      subtask_title: str("Subtask title"),
      subtask_description: str("Description"),
      files: arr(str(), "Files to work on"),
      shared_context: str("Shared context"),
    },
    ["bead_id", "epic_id", "subtask_title", "files"],
  ),
  deprecated(
    "swarm_complete_subtask",
    "Legacy completion handler. V2 workers report completion through swarm_complete or swarm_progress(status=completed).",
    "Absent de swarm 0.63.2 (aucun backend compatible) ; remplacé par swarm_review_feedback puis swarm_complete, ou swarm_progress(status=completed).",
    {
      bead_id: str("Cell ID"),
      task_result: str("Task result JSON"),
      files_touched: arr(str(), "Files modified"),
    },
    ["bead_id", "task_result"],
  ),
  backend(
    "swarm_spawn_retry",
    "Generate a retry prompt for a failed subtask. Used when swarm_review_feedback returns needs_changes — the original worker is dead; spawn a NEW worker with this prompt. Requires the root cause of the failure (failure_reason, failed_command or error_excerpt); it is injected into the prompt and recorded on the mission.",
    {
      bead_id: str("Cell ID"),
      epic_id: str("Epic ID"),
      original_prompt: str("Original task prompt given to the worker"),
      attempt: num("Retry attempt number (max 3)", { integer: true, minimum: 1 }),
      issues: str("Issues found during review that must be fixed"),
      diff: str("Current git diff of changes"),
      files: arr(str(), "Files to work on"),
      project_path: str("Project path"),
      failure_reason: str(
        "Root cause of the previous failure (required unless failed_command or error_excerpt is given)",
      ),
      failed_command: str("Exact command that failed in the previous attempt"),
      error_excerpt: str("Relevant error output from the previous attempt"),
    },
    ["bead_id", "epic_id", "original_prompt", "attempt", "issues", "files"],
  ),
  backend(
    "swarm_spawn_researcher",
    "Generate a read-only research prompt for a swarm/swarm-researcher cell. This tool does not dispatch; attach the prompt to the assigned cell and use V2 subagent with its exact cell marker.",
    {
      research_id: str("Research ID"),
      epic_id: str("Epic ID"),
      tech_stack: arr(str(), "Technologies to research"),
      project_path: str("Project path"),
      check_upgrades: bool("Check for available upgrades"),
    },
    ["research_id", "epic_id", "tech_stack", "project_path"],
  ),
  backend(
    "swarm_evaluation_prompt",
    "Generate self-evaluation prompt for a completed subtask",
    {
      bead_id: str("Cell ID"),
      subtask_title: str("Subtask title"),
      files_touched: arr(str(), "Files modified"),
    },
    ["bead_id", "subtask_title", "files_touched"],
  ),
  backend(
    "swarm_broadcast",
    "Broadcast context update to all agents working on the same epic",
    {
      project_path: str("Project path"),
      agent_name: str("Agent name"),
      epic_id: str("Epic ID"),
      message: str("Context update message"),
      importance: enumOf(["info", "warning", "blocker"], "Priority level (default: info)"),
      files_affected: arr(str(), "Files this context relates to"),
    },
    ["project_path", "agent_name", "epic_id", "message"],
  ),
];

const WORKTREE_REVIEW_SPECS: readonly ToolSpec[] = [
  backend(
    "swarm_worktree_create",
    "Create a git worktree for isolated task execution. Worker operates in worktree, not main branch.",
    {
      project_path: str("Absolute path to project root"),
      task_id: str("Task/bead ID (e.g., bd-abc123.1)"),
      start_commit: str("Commit SHA to create worktree at (swarm start point)"),
    },
    ["project_path", "task_id", "start_commit"],
  ),
  backend(
    "swarm_worktree_merge",
    "Cherry-pick commits from worktree back to main branch. Call after worker completes.",
    {
      project_path: str("Absolute path to project root"),
      task_id: str("Task/bead ID"),
      start_commit: str("Original start commit (to find new commits)"),
    },
    ["project_path", "task_id"],
  ),
  backend(
    "swarm_worktree_cleanup",
    "Coordinator-only: remove a task worktree after its worker attempt is complete/revoked, or clean all only after the mission ends.",
    {
      project_path: str("Absolute path to project root"),
      task_id: str("Task/bead ID to clean up"),
      cleanup_all: bool("Remove all worktrees for this project"),
    },
    ["project_path"],
  ),
  backend(
    "swarm_worktree_list",
    "List all active worktrees for a project",
    { project_path: str("Absolute path to project root") },
    ["project_path"],
  ),
  backend(
    "swarm_review",
    "Coordinator-only: generate a review prompt with the epic context and a complete diff limited to files_touched paths in the active project. files_touched may be empty for no-file tasks.",
    {
      project_key: str("Canonical active project root"),
      epic_id: str("Epic bead ID"),
      task_id: str("Subtask bead ID to review"),
      files_touched: withDescription(
        { type: "array", items: str(), minItems: 0 },
        "List of changed paths (may be empty for no-file tasks); review output includes only these files' diff",
      ),
    },
    ["project_key", "epic_id", "task_id"],
  ),
  backend(
    "swarm_review_feedback",
    "Coordinator-only: approve or request changes after swarmx records a complete scoped review diff. Requires a one-use receipt from swarm_review and tracks attempts (max 3).",
    {
      project_key: str("Project path"),
      task_id: str("Subtask bead ID"),
      worker_id: str("Worker agent name"),
      status: enumOf(["approved", "needs_changes", "unverifiable"], "Review status"),
      summary: str("Review summary"),
      issues: str("JSON array of ReviewIssue objects (for needs_changes)"),
    },
    ["project_key", "task_id", "worker_id", "status"],
  ),
  backend(
    "swarm_adversarial_review",
    `VDD-style adversarial code review using hostile, fresh-context agent.

Spawns Sarcasmotron - a hyper-critical reviewer with zero tolerance for slop.
Fresh context per review prevents "relationship drift" (becoming lenient over time).

Returns structured critique with verdict:
- APPROVED: Code is solid
- NEEDS_CHANGES: Real issues found
- HALLUCINATING: Adversary invented issues (code is excellent!)

Credit: VDD methodology from https://github.com/Vomikron/VDD
Credit: Chainlink patterns from https://github.com/dollspace-gay/chainlink`,
    { diff: str("Git diff of changes to review"), test_output: str("Test output (optional)") },
    ["diff"],
  ),
];

const SKILLS_SPECS: readonly ToolSpec[] = [
  backend(
    "skills_list",
    "List all available skills from global, project, and bundled sources",
    { source: enumOf(["all", "global", "project", "bundled"], "Filter by source (default: all)") },
  ),
  backend("skills_read", "Read a skill's full content including SKILL.md and references", { name: str("Skill name") }, [
    "name",
  ]),
  backend(
    "skills_use",
    "Get skill content formatted for injection into agent context. Use this when you need to apply a skill's knowledge to the current task.",
    {
      name: str("Skill name"),
      context: str("Optional context about how the skill will be used"),
    },
    ["name"],
  ),
  backend(
    "skills_create",
    "Create a new skill with SKILL.md template",
    {
      name: str("Skill name (kebab-case)"),
      description: str("Brief skill description"),
      scope: enumOf(["global", "project"], "Where to create (default: project)"),
      tags: arr(str(), "Skill tags for discovery"),
    },
    ["name", "description"],
  ),
  backend(
    "skills_update",
    "Update an existing skill's SKILL.md content",
    { name: str("Skill name"), content: str("New SKILL.md content") },
    ["name", "content"],
  ),
  backend("skills_delete", "Delete a skill (project skills only)", { name: str("Skill name") }, ["name"]),
  backend(
    "skills_init",
    "Initialize skills directory in current project",
    { path: str("Custom path (default: .opencode/skills)") },
  ),
  backend(
    "skills_add_script",
    "Add an executable script to a skill",
    {
      skill_name: str("Skill name"),
      script_name: str("Script filename"),
      content: str("Script content"),
      executable: bool("Make executable (default: true)"),
    },
    ["skill_name", "script_name", "content"],
  ),
  backend(
    "skills_execute",
    "Execute a skill's script",
    {
      skill_name: str("Skill name"),
      script_name: str("Script to execute"),
      args: arr(str(), "Script arguments"),
    },
    ["skill_name", "script_name"],
  ),
];

const INSIGHTS_DEPRECATED_SPECS: readonly ToolSpec[] = [
  deprecated(
    "swarm_get_strategy_insights",
    "Get strategy success rates for decomposition planning. Use this when planning task decomposition to see which strategies (file-based, feature-based, risk-based) have historically succeeded or failed. Returns success rates and recommendations based on past swarm outcomes.",
    "Absent de swarm 0.63.2 ; remplacé par swarm_insights (agrégats d'outcomes) puis swarm_select_strategy pour le choix.",
    { task: str("Task description to analyze for strategy recommendation") },
    ["task"],
  ),
  deprecated(
    "swarm_get_file_insights",
    "Get file-specific gotchas for worker context. Use this when assigning files to workers to warn them about historical failure patterns. Queries past outcomes and semantic memory for file-specific learnings (edge cases, common bugs, performance traps).",
    "Absent de swarm 0.63.2 ; remplacé par semantic-memory_find (mémoire sémantique) et swarm_insights (patterns d'échec).",
    { files: arr(str(), "File paths to get insights for") },
    ["files"],
  ),
  deprecated(
    "swarm_get_pattern_insights",
    "Get common failure patterns across swarms. Use this during planning or when debugging stuck swarms to see recurring anti-patterns (type errors, timeouts, conflicts, test failures). Returns top 5 most frequent failure patterns with recommendations.",
    "Absent de swarm 0.63.2 ; remplacé par swarm_insights (patterns d'échec agrégés).",
  ),
];

const CASS_SPECS: readonly ToolSpec[] = [
  backend(
    "cass_search",
    "Search across all AI coding agent histories (Claude, Codex, Cursor, Gemini, Aider, ChatGPT, Cline, OpenCode, Amp, Pi-Agent). Query BEFORE solving problems from scratch - another agent may have already solved it. Returns matching sessions ranked by relevance.",
    {
      query: str("Search query (e.g., 'authentication error Next.js')"),
      agent: str("Filter by agent name (e.g., 'claude', 'cursor')"),
      days: num("Only search sessions from last N days"),
      limit: num("Max results to return (default: 5)"),
      fields: str("Field selection: 'minimal' for compact output (path, line, agent only)"),
    },
    ["query"],
  ),
  backend(
    "cass_view",
    "View a specific conversation/session from search results. Use source_path from cass_search output.",
    {
      path: str("Path to session file (from cass_search results)"),
      line: num("Jump to specific line number"),
    },
    ["path"],
  ),
  backend(
    "cass_expand",
    "Expand context around a specific line in a session. Shows messages before/after.",
    {
      path: str("Path to session file"),
      line: num("Line number to expand around"),
      context: num("Number of lines before/after to show (default: 5)"),
    },
    ["path", "line"],
  ),
  backend(
    "cass_health",
    "Check if cass index is healthy. Exit 0 = ready, Exit 1 = needs indexing. Run this before searching.",
  ),
  backend(
    "cass_index",
    "Build or rebuild the search index. Run this if health check fails or to pick up new sessions.",
    { full: bool("Force full rebuild (default: incremental)") },
  ),
  backend("cass_stats", "Show index statistics - how many sessions, messages, agents indexed."),
];

const HIVEMIND_SPECS: readonly ToolSpec[] = [
  backend(
    "hivemind_store",
    "Record a memory (learnings, decisions, patterns) with metadata and tags. Include WHY, not just WHAT.",
    {
      information: str("The learning, decision, or pattern to store (include context and reasoning)"),
      tags: str("Comma-separated tags for categorization (e.g., 'auth,oauth,tokens')"),
    },
    ["information"],
  ),
  backend(
    "hivemind_find",
    "Search all memories (learnings + sessions) by semantic similarity. Use BEFORE implementing to check if any agent solved it before.",
    {
      query: str("Search query (e.g., 'token refresh race condition')"),
      limit: num("Max results to return (default: 5)"),
      collection: str("Filter by collection: 'default' (learnings), 'claude', 'cursor', etc., or omit for all"),
    },
    ["query"],
  ),
  backend("hivemind_get", "Get specific memory by ID", { id: str("Memory ID (e.g., 'mem_xyz123')") }, ["id"]),
  backend("hivemind_remove", "Delete outdated/incorrect memory", { id: str("Memory ID to remove") }, ["id"]),
  backend(
    "hivemind_validate",
    "Confirm memory is still accurate (resets 90-day decay timer)",
    { id: str("Memory ID to validate") },
    ["id"],
  ),
  backend("hivemind_stats", "Memory statistics and health check (documents, chunks, embeddings)"),
  backend(
    "hivemind_index",
    "Index AI session directories (automatically indexes ~/.config/opencode/sessions, ~/.cursor-tutor, etc.)",
  ),
  backend("hivemind_sync", "Sync learnings to .hive/memories.jsonl for git-backed team sharing"),
];

/**
 * Local tools. Handlers run in-process and throw a typed `LocalToolError` when
 * a dependency is missing, so no caller ever sees a silent fake success.
 *
 * `swarm_subtask_prompt` is deliberately served locally even though the CLI
 * 0.63.2 also exposes a backend by that name: the worker marker and protocol
 * deduplication must hold whatever the CLI does, so swarmx owns the rendering.
 */
const LOCAL_SPECS: readonly ToolSpec[] = [
  local(
    "swarm_roster",
    "List dispatchable agents (mode all/subagent) with descriptions. Source of truth for agent selection — replaces the prose roster in swarmx.md.",
  ),
  local(
    "swarm_set_budget",
    "Coordinator-only: fix the spawn and iteration ceilings for the current session. Numbers live in state, not in prose. Call once at Phase 0.",
    {
      mode: enumOf(["audit", "dev"], "Mission mode (default: dev)"),
      max_spawns: num("Spawn ceiling (default: 10 audit / 20 dev)"),
      max_iterations: num("Review iterations per cell (default: 3)"),
    },
  ),
  local(
    "swarm_resolve_agent",
    "Coordinator-only: resolve the best dispatchable agent per cell and, when apply=true, persist its canonical V2 ID in swarmx storage (not Hive). Returns null + needs_arbitration instead of silently defaulting to swarm-worker.",
    {
      cells: arr(
        obj(
          {
            bead_id: str(),
            title: str(),
            files: arr(str()),
            tier: enumOf(["fast", "medium", "heavy"], "Preferred tier when a matching tier agent exists"),
          },
          ["title"],
        ),
        "Cells to place",
      ),
      swarm_worker: str("Name of the mechanical fallback agent (default: swarm-worker)"),
      apply: bool("Persist assignments in swarmx storage; the gate reads this assignment"),
    },
    ["cells"],
  ),
  local(
    "swarm_set_agent",
    "Coordinator-only: persist a cell's canonical V2 agent ID in swarmx storage (not in Hive). Makes the dispatch decision auditable after the fact.",
    {
      bead_id: str("Cell ID"),
      agent: str("Agent ID or roster name; the canonical V2 ID is stored"),
      rationale: str("Why this agent"),
    },
    ["bead_id", "agent"],
  ),
  local(
    "swarm_subtask_prompt",
    "Generate the assigned cell's V2 subagent prompt. Embeds the worker protocol exactly once; fails closed with a load-or-stop instruction when the host cannot supply it. Requires at least one file path and does not dispatch.",
    {
      agent_name: str("Agent name"),
      bead_id: str("Cell ID"),
      epic_id: str("Epic ID"),
      subtask_title: str("Subtask title"),
      subtask_description: str("Description"),
      files: arr(str(), "Files to work on"),
      shared_context: str("Shared context"),
    },
    ["agent_name", "bead_id", "epic_id", "subtask_title", "files"],
  ),
  local(
    "swarm_agent_audit",
    "Audit the current mission's agent dispatch: assignments, spawn counts, swarm-worker share, gate status.",
  ),
  local(
    "swarm_finish",
    "Coordinator-only: finish the current swarmx mission, deactivate dispatch gates, and report the closing reason. Set abandon=true to revoke all pending/succeeded attempts and force-close. Use session_id to target another session, or all_sessions=true to abandon every active mission in the project.",
    {
      reason: str("Why the mission ends"),
      abandon: bool("Revoke all pending/succeeded attempts and force-close the mission"),
      session_id: str("Target session ID (defaults to current session)"),
      all_sessions: bool("Abandon all active missions in the project"),
    },
  ),
  local(
    "swarm_mission_status",
    "Coordinator-only: read-only status of all missions and attempts in the project, including stale sessions and orphaned attempts.",
  ),
  local(
    "swarm_cancel_completion",
    "Coordinator-only: cancel a pending completion without a review receipt. Requires an explicit reason; preserves history and frees the cell for retry or blocked.",
    { bead_id: str("Cell ID"), reason: str("Cancellation reason", { minLength: 1 }) },
    ["bead_id", "reason"],
  ),
  local(
    "swarm_amend_completion",
    "Worker-only: amend files_touched on your own pending completion. Excludes untracked files and files without a diff; returns the effective list.",
    {
      bead_id: str("Cell ID"),
      files_touched: arr(str(), "Requested file paths"),
      reason: str("Amendment reason", { minLength: 1 }),
    },
    ["bead_id", "files_touched", "reason"],
  ),
  local(
    "swarm_probe",
    "Coordinator-only: run a read-only probe (git status, gh pr checks, etc.) without dispatching a worker. Does not consume spawn or iteration budget.",
    { command: str("Read-only command to execute", { minLength: 1 }) },
  ),
  local(
    "swarm_reset",
    "Reset the current swarm mission: clear attempts, assignments, and budget. Use to recover from a blocked mission.",
  ),
  local(
    "swarm_repo_inventory",
    "Generate a read-only repo inventory: file count by top-level directory and extension, plus a bounded file list. Useful for audit and decomposition.",
  ),
  local(
    "swarm_preflight",
    "Check repository prerequisites before running swarm work: dependencies, test runner, Git remote, GitHub CLI, and working-tree cleanliness. Dirty trees require an explicit audited override.",
    {
      allow_dirty: bool("Accept a dirty working tree after an explicit audit"),
      dirty_reason: str("Why existing changes were audited and accepted", { minLength: 1 }),
    },
  ),
];

/** All exposed tool specs (82). */
export const SWARMX_TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  ...HIVE_SPECS,
  ...SWARM_MAIL_SPECS,
  ...STRUCTURED_SPECS,
  ...SWARM_SPECS,
  ...WORKTREE_REVIEW_SPECS,
  ...SKILLS_SPECS,
  ...INSIGHTS_DEPRECATED_SPECS,
  ...CASS_SPECS,
  ...HIVEMIND_SPECS,
  ...LOCAL_SPECS,
]);

const SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  SWARMX_TOOL_SPECS.map((spec) => [spec.name, spec]),
);

/**
 * Looks up a spec by effective tool name.
 *
 * @param name - exposed tool name (identical to the V1 name).
 * @returns The matching spec, or `undefined` when the name is unknown.
 */
export function findToolSpec(name: string): ToolSpec | undefined {
  return SPEC_BY_NAME.get(name);
}

/** @returns Exposed tool names, sorted for stable output. */
export function listToolNames(): string[] {
  return SWARMX_TOOL_SPECS.map((spec) => spec.name).sort();
}

/** One row of the V1 → V2 compatibility matrix. */
export interface CompatibilityRow {
  name: string;
  kind: ToolSpec["kind"];
  backendName?: string;
  status: ToolSpec["status"];
  reason?: string;
}

/**
 * @returns The compatibility matrix (name, kind, backendName, status, reason).
 */
export function getCompatibilityMatrix(): CompatibilityRow[] {
  return SWARMX_TOOL_SPECS.map((spec) => {
    const row: CompatibilityRow = { name: spec.name, kind: spec.kind, status: spec.status };
    if (spec.backendName !== undefined) {
      row.backendName = spec.backendName;
    }
    if (spec.deprecatedReason !== undefined) {
      row.reason = spec.deprecatedReason;
    }
    return row;
  });
}

function asArguments(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function asExecuteContext(context: unknown): ToolExecuteContextLike {
  if (typeof context !== "object" || context === null) return {};
  return context as ToolExecuteContextLike;
}

function normalizeAgentList(listed: DispatchAgentList): readonly RosterAgent[] {
  // `Array.isArray` does not narrow `readonly T[]` out of the union, hence the
  // explicit casts on both branches.
  const raw = Array.isArray(listed)
    ? (listed as readonly DispatchAgentInfo[])
    : (listed as { readonly data: readonly DispatchAgentInfo[] }).data;
  return raw.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    mode: agent.mode,
    hidden: agent.hidden,
  }));
}

async function loadRosterEntries(
  tool: string,
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<readonly RosterAgent[]> {
  // <!-- ponytail: V2 context.agent is the caller ID, not an agent-list API. -->
  const reader = runtime.listAgents;
  if (reader === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "no agent roster reader is wired");
  }
  try {
    return normalizeAgentList(await reader());
  } catch (error) {
    throw new LocalToolError(
      tool,
      "runtime_unavailable",
      `cannot read the agent roster: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveProjectID(runtime: SwarmxRuntime): string | undefined {
  const projectID = runtime.projectID;
  return typeof projectID === "string" && projectID.length > 0 ? projectID : undefined;
}

function resolveSessionID(runtime: SwarmxRuntime, context: ToolExecuteContextLike): string | undefined {
  if (typeof context.sessionID === "string" && context.sessionID.length > 0) return context.sessionID;
  // <!-- ponytail: V2 supplies sessionID directly; keep only the configured fallback. -->
  const provider = runtime.sessionID;
  if (typeof provider === "string") return provider.length > 0 ? provider : undefined;
  const provided = provider?.();
  return typeof provided === "string" && provided.length > 0 ? provided : undefined;
}

/** Session-only fallback for gates that run without a per-call context. */
function runtimeSessionID(runtime: SwarmxRuntime): string | undefined {
  const provider = runtime.sessionID;
  if (typeof provider === "string") return provider.length > 0 ? provider : undefined;
  const provided = provider?.();
  return typeof provided === "string" && provided.length > 0 ? provided : undefined;
}

interface WorkUnitMissionScope {
  readonly mission: Mission;
  readonly projectID: string;
  readonly sessionID: string;
  readonly runtime: NonNullable<SwarmxRuntime["workUnit"]>;
}

async function requireWorkUnitMissionScope(
  tool: string,
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<WorkUnitMissionScope> {
  const workUnit = runtime.workUnit;
  const projectID = resolveProjectID(runtime);
  const sessionID = resolveSessionID(runtime, context);
  if (workUnit === undefined || projectID === undefined || sessionID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "WorkUnit mission runtime or session is not wired");
  }
  const mission = await getMission(workUnit.db, projectID, sessionID);
  if (mission === null) {
    throw new LocalToolError(tool, "runtime_unavailable", "native mission is not available for this session");
  }
  return { runtime: workUnit, mission, projectID, sessionID };
}

async function assignWorkUnitCell(
  tool: string,
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  cellID: string,
  agent: string,
): Promise<void> {
  const scope = await requireWorkUnitMissionScope(tool, runtime, context);
  const actor = { kind: "coordinator" as const, sessionId: scope.sessionID };
  const existingResult = await scope.runtime.db.query(
    "SELECT agent, state FROM swarmx_legacy_assignments WHERE project = ? AND cell_id = ? AND mission_pk = ?",
    [scope.projectID, cellID, scope.mission.id],
  );
  const existing: unknown = existingResult.rows[0];
  if (
    typeof existing === "object" && existing !== null && "state" in existing &&
    existing.state === "assigned" && "agent" in existing && typeof existing.agent === "string" &&
    existing.agent !== agent
  ) {
    await scope.runtime.commands.releaseAssignment(actor, { missionPk: scope.mission.id, cellId: cellID });
  }
  await scope.runtime.commands.assignCell(actor, { missionPk: scope.mission.id, cellId: cellID, agent });
}

const LIVE_UNIT_STATES: ReadonlySet<string> = new Set([
  "RESERVED", "BOUND", "SUBMITTED", "IN_REVIEW", "APPROVED", "PUBLISHING", "RETURNING",
]);
const APPROVED_UNIT_STATES: ReadonlySet<string> = new Set(["APPROVED", "PUBLISHING", "DONE"]);

function isLiveMission(mission: Mission): boolean {
  return mission.state === "OPEN" || mission.state === "CLOSING";
}

/** Read-only project scan: every mission generation with its units. */
async function listProjectNative(
  db: NonNullable<SwarmxRuntime["workUnit"]>["db"],
  projectID: string,
): Promise<{ readonly mission: Mission; readonly units: WorkUnit[] }[]> {
  const missions = await listMissions(db, projectID);
  return Promise.all(missions.map(async (mission) => ({ mission, units: await listUnits(db, mission.id) })));
}

function nativeOrphanCandidates(runtime: SwarmxRuntime, units: WorkUnit[]): WorkUnit[] {
  return selectMissionOrphanCandidates({
    units,
    now: runtime.now?.() ?? Date.now(),
    orphanGraceMs: runtime.orphanGraceMs ?? 0,
  });
}

/** Display-only ledger view of a WorkUnit (never persisted). */
function unitAttempt(mission: Mission, unit: WorkUnit): DispatchAttempt {
  const status: DispatchAttempt["status"] = unit.state === "DONE"
    ? "succeeded"
    : LIVE_UNIT_STATES.has(unit.state)
      ? "pending"
      : unit.state === "FAILED" || unit.state === "REJECTED" ? "failed" : "aborted";
  return {
    callID: unit.call_id,
    missionID: mission.mission_id,
    sessionID: mission.session_id,
    cellID: unit.cell_id ?? "",
    ...(mission.epic_id === null ? {} : { epicID: mission.epic_id }),
    agent: unit.worker_agent ?? "",
    status,
    ts: new Date(unit.created_at).toISOString(),
    ...(unit.worker_session === null ? {} : { workerSessionID: unit.worker_session }),
    ...(unit.state === "REVOKED" ? { revokedAt: new Date(unit.updated_at).toISOString() } : {}),
  };
}

/** Lifecycle tools are WorkUnit-only: fail typed instead of falling back to raw KV. */
function requireWorkUnitRuntime(tool: string, runtime: SwarmxRuntime): NonNullable<SwarmxRuntime["workUnit"]> {
  if (runtime.workUnit === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "WorkUnit runtime is not wired");
  }
  return runtime.workUnit;
}

function requireStringInput(tool: string, input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocalToolError(tool, "invalid_input", `${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringInput(
  tool: string,
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new LocalToolError(tool, "invalid_input", `${key} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalNumberInput(
  tool: string,
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LocalToolError(tool, "invalid_input", `${key} must be a finite number when provided`);
  }
  return value;
}

function requireStringArrayInput(
  tool: string,
  input: Record<string, unknown>,
  key: string,
): string[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    throw new LocalToolError(tool, "invalid_input", `${key} must be an array of strings`);
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (strings.length !== value.length) {
    throw new LocalToolError(tool, "invalid_input", `${key} must contain only non-empty strings`);
  }
  return strings.map((entry) => entry.trim());
}

function canonicalAgent(agent: RosterAgent): RosterAgent {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    mode: agent.mode,
    hidden: agent.hidden,
  };
}

function findRosterAgent(roster: readonly RosterAgent[], raw: string): RosterAgent | undefined {
  const target = raw.trim().toLowerCase();
  const targetSegment = target.split("/").pop() ?? target;
  return roster.find((agent) => {
    const id = agent.id.toLowerCase();
    const name = agent.name.toLowerCase();
    return (
      id === target ||
      name === target ||
      (id.split("/").pop() ?? id) === targetSegment ||
      (name.split("/").pop() ?? name) === targetSegment
    );
  });
}

function rosterContent(roster: readonly RosterAgent[]): string {
  const lines = roster.map(
    (agent) => `* ${agent.id} (${agent.mode})${agent.description === undefined ? "" : ` — ${agent.description}`}`,
  );
  return [`${roster.length} dispatchable agents`, ...lines].join("\n");
}

async function runRoster(runtime: SwarmxRuntime, context: ToolExecuteContextLike): Promise<ToolExecuteResult> {
  const all = await loadRosterEntries("swarm_roster", runtime, context);
  const dispatchable = listRoster(all).map(canonicalAgent);
  return {
    output: { total: all.length, count: dispatchable.length, agents: dispatchable },
    content: rosterContent(dispatchable),
  };
}

interface ParsedCell {
  readonly beadID?: string;
  readonly title: string;
  readonly files?: readonly string[];
  readonly tier?: "fast" | "medium" | "heavy";
}

function parseCells(input: Record<string, unknown>): ParsedCell[] {
  const raw = input.cells;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new LocalToolError("swarm_resolve_agent", "invalid_input", "cells must be a non-empty array");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new LocalToolError("swarm_resolve_agent", "invalid_input", `cells[${index}] must be an object`);
    }
    const cell = entry as Record<string, unknown>;
    const title = cell.title;
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new LocalToolError(
        "swarm_resolve_agent",
        "invalid_input",
        `cells[${index}].title must be a non-empty string`,
      );
    }
    const beadID = cell.bead_id;
    if (beadID !== undefined && (typeof beadID !== "string" || beadID.trim().length === 0)) {
      throw new LocalToolError(
        "swarm_resolve_agent",
        "invalid_input",
        `cells[${index}].bead_id must be a non-empty string when provided`,
      );
    }
    const files = cell.files;
    if (files !== undefined && (!Array.isArray(files) || files.some((file) => typeof file !== "string"))) {
      throw new LocalToolError(
        "swarm_resolve_agent",
        "invalid_input",
        `cells[${index}].files must be an array of strings when provided`,
      );
    }
    const tier = cell.tier;
    if (tier !== undefined && tier !== "fast" && tier !== "medium" && tier !== "heavy") {
      throw new LocalToolError(
        "swarm_resolve_agent",
        "invalid_input",
        `cells[${index}].tier must be fast, medium, or heavy when provided`,
      );
    }
    return {
      ...(beadID === undefined ? {} : { beadID: beadID as string }),
      title: title.trim(),
      ...(files === undefined ? {} : { files: (files as string[]).map((file) => file.trim()) }),
      ...(tier === undefined ? {} : { tier }),
    };
  });
}

async function runResolveAgent(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const cells = parseCells(input);
  const worker = optionalStringInput("swarm_resolve_agent", input, "swarm_worker") ?? SWARM_WORKER_AGENT_ID;
  const apply = input.apply === true;
  const roster = await loadRosterEntries("swarm_resolve_agent", runtime, context);

  const results = cells.map((cell) => {
    // Tech hints take priority over tier: if the files indicate a specialized
    // agent that exists in the roster, use it instead of the generic tier.
    const techResolved = resolveAgent(
      { title: cell.title, ...(cell.files === undefined ? {} : { files: cell.files }) },
      roster,
      worker,
    );
    const tierAgent =
      cell.tier === undefined
        ? undefined
        : roster.find(
            (entry) =>
              (entry.id === cell.tier || entry.name === cell.tier) &&
              !entry.hidden &&
              entry.mode !== "primary",
          );
    const resolved =
      techResolved.agent !== null && techResolved.agent !== worker
        ? techResolved
        : tierAgent === undefined
          ? techResolved
          : {
              agent: tierAgent.id,
              rationale: `explicit tier ${cell.tier}: ${tierAgent.id}`,
              needs_arbitration: false,
              candidates: [tierAgent.id],
            };
    return {
      ...(cell.beadID === undefined ? {} : { bead_id: cell.beadID }),
      title: cell.title,
      ...(cell.tier === undefined ? {} : { tier: cell.tier }),
      ...resolved,
    };
  });

  if (apply) {
    for (const result of results) {
      if (result.agent === null) continue;
      if (result.bead_id === undefined) {
        throw new LocalToolError(
          "swarm_resolve_agent",
          "invalid_input",
          `cannot persist the assignment of "${result.title}": bead_id is required when apply=true`,
        );
      }
      await assignWorkUnitCell("swarm_resolve_agent", runtime, context, result.bead_id, result.agent);
    }
  }

  const arbitrations = results.filter((result) => result.needs_arbitration).length;
  const lines = results.map((result) => {
    const id = result.bead_id ?? "(no bead_id)";
    const target = result.agent ?? "ARBITRATION REQUIRED";
    return `- ${id} -> ${target} [${result.rationale}]`;
  });
  return {
    output: {
      apply,
      roster: { total: roster.length, dispatchable: listRoster(roster).length },
      needsArbitration: arbitrations,
      results,
    },
    content: [
      `${results.length} cells, ${arbitrations} need arbitration, ${results.length - arbitrations} placed.`,
      apply ? "Assignments persisted." : "Pass apply=true to persist assignments.",
      ...lines,
    ].join("\n"),
  };
}

async function runSetAgent(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const beadID = requireStringInput("swarm_set_agent", input, "bead_id");
  const requested = requireStringInput("swarm_set_agent", input, "agent");
  const rationale = optionalStringInput("swarm_set_agent", input, "rationale") ?? "";
  const roster = await loadRosterEntries("swarm_set_agent", runtime, context);
  const entry = findRosterAgent(roster, requested);
  if (entry === undefined) {
    throw new LocalToolError(
      "swarm_set_agent",
      "agent_unknown",
      `agent "${requested}" is not in the roster; run swarm_roster for the exact ids`,
    );
  }
  if (entry.hidden || entry.mode === "primary") {
    throw new LocalToolError(
      "swarm_set_agent",
      "agent_not_dispatchable",
      `agent "${entry.id}" is ${entry.hidden ? "hidden" : "primary"} and cannot receive subtasks`,
    );
  }
  await assignWorkUnitCell("swarm_set_agent", runtime, context, beadID, entry.id);
  return {
    output: { bead_id: beadID, agent: entry.id, rationale, persisted: true },
    content: `Assignment stored for ${beadID}: agent=${entry.id}`,
  };
}

async function runSubtaskPrompt(
  runtime: SwarmxRuntime,
  input: Record<string, unknown>,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const sharedContext = optionalStringInput("swarm_subtask_prompt", input, "shared_context");
  // Fail closed: a missing or blank protocol resolves to the load-or-stop
  // instruction instead of rendering an unguarded prompt.
  const protocol = resolveWorkerProtocol(runtime.workerProtocol);
  if (protocol === WORKER_PROTOCOL_FALLBACK) {
    // The catalogue carried no swarm-worker-protocol skill: the prompt still
    // fails closed, but the gap is a violation worth recording.
    emitViolation(runtime.sessionEvents, {
      sessionID: resolveSessionID(runtime, context),
      epicID: typeof input.epic_id === "string" ? input.epic_id : undefined,
      violationType: "missing_worker_protocol",
      payload: {
        tool: "swarm_subtask_prompt",
        bead_id: typeof input.bead_id === "string" ? input.bead_id : null,
        agent_name: typeof input.agent_name === "string" ? input.agent_name : null,
      },
    });
  }
  const promptInput: RenderPromptInput = {
    cellID: requireStringInput("swarm_subtask_prompt", input, "bead_id"),
    epicID: requireStringInput("swarm_subtask_prompt", input, "epic_id"),
    agent: requireStringInput("swarm_subtask_prompt", input, "agent_name"),
    title: requireStringInput("swarm_subtask_prompt", input, "subtask_title"),
    description: requireStringInput("swarm_subtask_prompt", input, "subtask_description"),
    files: requireStringArrayInput("swarm_subtask_prompt", input, "files"),
    ...(sharedContext === undefined ? {} : { sharedContext }),
    protocol,
  };
  const prompt = renderSubtaskPrompt(promptInput);
  const injections = countOccurrences(prompt, protocol);
  if (injections !== 1) {
    throw new LocalToolError(
      "swarm_subtask_prompt",
      "protocol_injection_invalid",
      `the worker protocol must appear exactly once in the rendered prompt (found ${injections})`,
    );
  }
  return {
    output: {
      agent: promptInput.agent,
      bead_id: promptInput.cellID,
      epic_id: promptInput.epicID,
      prompt,
    },
    content: prompt,
  };
}

/** Root-cause argument names owned by the plugin; stripped before the backend call. */
const RETRY_CAUSE_ARG_NAMES = ["failure_reason", "failed_command", "error_excerpt"] as const;

function parseBackendJson(text: string): Record<string, unknown> | undefined {
  try {
    return asArguments(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Appends the root-cause section to the backend-generated retry prompt.
 *
 * Fail-closed: an output that carries no prompt is refused rather than returned
 * without the cause.
 */
function injectRetryRootCause(tool: string, output: unknown, section: string): unknown {
  const parsed = typeof output === "string" ? parseBackendJson(output) : asArguments(output);
  if (parsed !== undefined && typeof parsed.prompt === "string") {
    return { ...parsed, prompt: `${parsed.prompt}\n\n${section}` };
  }
  if (typeof output === "string" && parsed === undefined && output.trim().length > 0) {
    return `${output}\n\n${section}`;
  }
  throw new LocalToolError(
    tool,
    "runtime_unavailable",
    "the retry backend returned no prompt to inject the root cause into",
  );
}

/**
 * Tools whose output is a decomposition prompt: they get the hive's history
 * injected before the backend runs (P1.10).
 */
const DECOMPOSITION_HISTORY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "swarm_decompose",
  "swarm_plan_prompt",
]);

/**
 * Runs a decomposition tool with related hive history injected.
 *
 * The lookup is advisory: zero hits (or a failed lookup) still run the backend,
 * and the warning travels back in the result `history` field.
 */
async function runDecomposition(
  runtime: SwarmxRuntime,
  tool: string,
  input: Record<string, unknown>,
  backendName: string,
  sessionID: string,
): Promise<ToolExecuteResult> {
  const task = requireStringInput(tool, input, "task");
  // `query_cass: false` is the caller's explicit opt-out of history lookups.
  if (input.query_cass === false) {
    const output = await runToolForSession(runtime, backendName, input, sessionID);
    return { output };
  }
  const history = await queryDecompositionHistory(runtime, task, { sessionID });
  const enriched = injectHistoryContext(input, history);
  const output = await runToolForSession(runtime, backendName, enriched, sessionID);
  return { output: attachHistorySummary(output, history) };
}

/**
 * Generates a retry prompt that carries the failure's root cause.
 *
 * The cause is mandatory (see {@link parseRetryRootCause}), injected into the
 * backend prompt and recorded on the mission for audit.
 */
async function runSpawnRetry(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
  backendName: string,
  sessionID: string,
): Promise<ToolExecuteResult> {
  const tool = "swarm_spawn_retry";
  const cellID = requireStringInput(tool, input, "bead_id");
  const epicID = requireStringInput(tool, input, "epic_id");
  const attempt = input.attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new LocalToolError(tool, "invalid_input", "attempt must be a positive integer");
  }

  let cause: ReturnType<typeof parseRetryRootCause>;
  try {
    cause = parseRetryRootCause(input);
  } catch (error) {
    if (error instanceof RetryCauseError) {
      throw new LocalToolError(tool, "invalid_input", error.message);
    }
    throw error;
  }
  const section = renderRetryRootCause(cause);

  const forwarded: Record<string, unknown> = { ...input };
  for (const field of RETRY_CAUSE_ARG_NAMES) delete forwarded[field];

  const output = await runToolForSession(runtime, backendName, forwarded, sessionID);
  const injected = injectRetryRootCause(tool, output, section);

  const projectID = resolveProjectID(runtime);
  const nativeRuntime = runtime.workUnit;
  if (nativeRuntime !== undefined && projectID !== undefined) {
    const mission = await getMission(nativeRuntime.db, projectID, sessionID);
    if (mission !== null) {
      await nativeRuntime.commands.recordRetryCause({ kind: "coordinator", sessionId: sessionID }, {
        missionPk: mission.id,
        cause: { ...cause, cellID, epicID, attempt, ts: new Date(runtime.now?.() ?? Date.now()).toISOString() },
      });
    }
  }

  return { output: injected };
}

async function runSetBudget(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const modeInput = optionalStringInput("swarm_set_budget", input, "mode");
  if (modeInput !== undefined && modeInput !== "audit" && modeInput !== "dev") {
    throw new LocalToolError("swarm_set_budget", "invalid_input", "mode must be 'audit' or 'dev'");
  }
  const mode: MissionMode = modeInput ?? "dev";
  const maxSpawns =
    optionalNumberInput("swarm_set_budget", input, "max_spawns") ?? (mode === "audit" ? 10 : 20);
  const maxIterations = optionalNumberInput("swarm_set_budget", input, "max_iterations") ?? 3;
  return runNativeSetBudget(runtime, context, requireWorkUnitRuntime("swarm_set_budget", runtime), mode, maxSpawns, maxIterations);
}

async function runNativeSetBudget(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  native: NonNullable<SwarmxRuntime["workUnit"]>,
  mode: MissionMode,
  maxSpawns: number,
  maxIterations: number,
): Promise<ToolExecuteResult> {
  const tool = "swarm_set_budget";
  const projectID = resolveProjectID(runtime);
  const sessionID = resolveSessionID(runtime, context);
  if (projectID === undefined) throw new LocalToolError(tool, "runtime_unavailable", "project id is not wired");
  if (sessionID === undefined) throw new LocalToolError(tool, "runtime_unavailable", "no session id in the tool context");
  let mission: Mission;
  try {
    mission = await native.commands.setBudget({ kind: "coordinator", sessionId: sessionID }, {
      project: projectID,
      sessionId: sessionID,
      mode,
      budgetPolicy: {
        total: maxSpawns,
        perCellIterations: maxIterations,
        workerShare: { agent: "swarm-worker", maxFraction: DEFAULT_WORKER_SHARE },
        version: 1,
      },
    });
  } catch (error) {
    if (error instanceof MissionConflictError) {
      throw new LocalToolError(
        tool,
        "conflict",
        `swarmx: mission budget already set for session ${sessionID}; ` +
          "the budget is fixed once per mission — run swarm_finish before setting a new one",
      );
    }
    if (error instanceof MissionPolicyValidationError) throw new LocalToolError(tool, "invalid_input", error.message);
    throw error;
  }
  const state = projectMission({ mission, units: [], assignments: [] });
  return {
    output: { sessionID, mode: state.mode, active: state.active, budget: state.budget },
    content:
      `Budget fixed: mode=${state.mode} max_spawns=${state.budget.maxSpawns} ` +
      `max_iterations=${state.budget.maxIterations}`,
  };
}

/**
 * Refuses `swarm_finish` while an epic still owes its consolidation.
 *
 * Rule: an epic with more than one work cell must be consolidated (a
 * `completed` consolidation) before the mission closes; a single-cell epic or a
 * mission whose attempts carry no epic needs nothing.
 *
 * Read-only and best effort: when `hive_cells` is unavailable the finish is
 * allowed — a backend read failure must not deadlock the coordinator. The
 * consolidation cell itself is not counted as a work cell.
 */
async function assertConsolidationComplete(
  runtime: SwarmxRuntime,
  sessionID: string,
  consolidationState: ConsolidationState | undefined,
  attemptEpicIDs: Iterable<string | undefined>,
): Promise<void> {
  const epicIDs = new Set<string>();
  if (consolidationState !== undefined) epicIDs.add(consolidationState.epicID);
  for (const attemptEpicID of attemptEpicIDs) {
    if (attemptEpicID !== undefined && attemptEpicID.length > 0) epicIDs.add(attemptEpicID);
  }
  for (const epicID of epicIDs) {
    const consolidation = consolidationState?.epicID === epicID ? consolidationState : undefined;
    if (consolidation?.status === "completed") continue;
    let children: readonly EpicChildCell[];
    try {
      children = await listEpicChildCells(runtime, sessionID, epicID);
    } catch {
      continue;
    }
    // Self-healing: a consolidation cell already closed in the hive wins over
    // the persisted pointer (the coordinator may have closed it directly).
    const consolidationCell =
      consolidation === undefined
        ? undefined
        : children.find((cell) => cell.id === consolidation.cellID);
    if (consolidationCell !== undefined && isConsolidationCellFinished(consolidationCell.status)) {
      continue;
    }
    const workCells = children.filter(
      (cell) => cell.id !== epicID && cell.id !== consolidation?.cellID,
    );
    if (workCells.length <= 1) continue;
    throw new LocalToolError(
      "swarm_finish",
      "conflict",
      `consolidation required: epic ${epicID} has ${workCells.length} cells and no completed consolidation (${consolidation === undefined ? "none prepared" : `status=${consolidation.status}`})`,
    );
  }
}

async function runMissionStatus(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const native = requireWorkUnitRuntime("swarm_mission_status", runtime);
  const projectID = resolveProjectID(runtime);
  if (projectID === undefined) {
    throw new LocalToolError("swarm_mission_status", "runtime_unavailable", "project id is not wired");
  }
  return runNativeMissionStatus(runtime, native, projectID);
}

async function runNativeMissionStatus(
  runtime: SwarmxRuntime,
  native: NonNullable<SwarmxRuntime["workUnit"]>,
  projectID: string,
): Promise<ToolExecuteResult> {
  const generations = await listProjectNative(native.db, projectID);
  // One row per session: its live generation, else its latest (list is newest first).
  const bySession = new Map<string, (typeof generations)[number]>();
  for (const entry of generations) {
    const current = bySession.get(entry.mission.session_id);
    if (current === undefined || (!isLiveMission(current.mission) && isLiveMission(entry.mission))) {
      bySession.set(entry.mission.session_id, entry);
    }
  }
  const rows = [...bySession.values()].map(({ mission, units }) => {
    const state = projectMission({ mission, units, assignments: [] });
    return {
      sessionID: state.sessionID,
      active: state.active,
      mode: state.mode,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      counts: state.counts,
      attempts: units.length,
      unrevokedAttempts: units.filter(
        (unit) => unit.state !== "REVOKED" && (LIVE_UNIT_STATES.has(unit.state) || unit.state === "DONE"),
      ).length,
      pendingCompletions: units
        .filter((unit) => (unit.state === "SUBMITTED" || unit.state === "IN_REVIEW") && unit.cell_id !== null)
        .map((unit) => unit.cell_id as string),
    };
  });
  const orphanCount = nativeOrphanCandidates(runtime, generations.flatMap((entry) => entry.units)).length;
  return {
    output: { projectID, missions: rows, orphanAttempts: orphanCount },
    content: rows
      .map(
        (row) =>
          `${row.active ? "ACTIVE" : "inactive"} ${row.sessionID} mode=${row.mode} spawns=${row.counts.spawns} unrevoked=${row.unrevokedAttempts} pending=${row.pendingCompletions.length}`,
      )
      .concat(`orphan attempts: ${orphanCount}`)
      .join("\n"),
  };
}

async function runFinish(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const reason = optionalStringInput("swarm_finish", input, "reason") ?? "";
  const abandon = input.abandon === true;
  requireWorkUnitRuntime("swarm_finish", runtime);
  return runNativeFinish(runtime, context, input, reason, abandon);
}

async function runCancelCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  requireWorkUnitRuntime("swarm_cancel_completion", runtime);
  return runNativeCancelCompletion(runtime, context, input);
}

async function runAmendCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const beadID = requireStringInput("swarm_amend_completion", input, "bead_id");
  const reason = requireStringInput("swarm_amend_completion", input, "reason");
  const scope = await requireAssignedWorkerScope(runtime, context, "swarm_amend_completion");
  requireWorkUnitRuntime("swarm_amend_completion", runtime);
  return runNativeAmendCompletion(runtime, context, input, scope, beadID, reason);
}

async function runReset(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const scope = await requireWorkUnitMissionScope("swarm_reset", runtime, context);
  await scope.runtime.commands.cancel(
    { kind: "coordinator", sessionId: scope.sessionID },
    { missionPk: scope.mission.id },
  );
  return {
    output: { sessionID: scope.sessionID, reset: true },
    content: `Mission ${scope.sessionID} reset. Call swarm_set_budget to start a new mission.`,
  };
}

async function runRepoInventory(
  runtime: SwarmxRuntime,
  _context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const root = await canonicalProjectRoot("swarm_repo_inventory", runtime);
  const result = Bun.spawnSync(["git", "ls-files"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new LocalToolError(
      "swarm_repo_inventory",
      "runtime_unavailable",
      `git ls-files failed in ${root}: ${result.stderr.toString().trim()}`,
    );
  }
  const files = result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const byTopLevel: Record<string, number> = {};
  const byExtension: Record<string, number> = {};
  for (const file of files) {
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
    byTopLevel[top] = (byTopLevel[top] ?? 0) + 1;
    const dot = file.lastIndexOf(".");
    const ext = dot >= 0 ? file.slice(dot + 1) : "(none)";
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }
  const top = Object.entries(byTopLevel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");
  return {
    output: {
      root,
      total: files.length,
      byTopLevel,
      byExtension,
      files: files.slice(0, 500),
    },
    content: `${files.length} tracked files. Top directories: ${top}.`,
  };
}

async function runPreflight(
  runtime: SwarmxRuntime,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const root = await canonicalProjectRoot("swarm_preflight", runtime);
  const nodeModulesAvailable = existsSync(resolve(root, "node_modules"));
  const testRunner = Bun.spawnSync(["bun", "test", "--help"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const remote = Bun.spawnSync(["git", "ls-remote", "origin"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const gh = Bun.spawnSync(["gh", "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const statusLines = status.stdout.toString().split("\n").filter((line) => line.length > 0);
  const changedFiles = statusLines.map((line) => line.slice(3));
  const untrackedFiles = statusLines.filter((line) => line.startsWith("??")).map((line) => line.slice(3));
  const clean = status.exitCode === 0 && changedFiles.length === 0;
  const dirtyReason = typeof input.dirty_reason === "string" ? input.dirty_reason.trim() : "";
  const dirtyAudited = input.allow_dirty === true && dirtyReason.length > 0;
  const testRunnerOk = testRunner.exitCode === 0;
  const remoteOk = remote.exitCode === 0;
  const ghOk = gh.exitCode === 0;
  const checks = [
    {
      name: "node_modules",
      ok: nodeModulesAvailable,
      detail: nodeModulesAvailable ? `found in ${root}` : `missing ${resolve(root, "node_modules")}`,
    },
    {
      name: "test runner",
      ok: testRunnerOk,
      detail: testRunnerOk
        ? "Bun test runner is available"
        : testRunner.stderr.toString().trim() || "Bun test runner is unavailable",
    },
    {
      name: "git remote",
      ok: remoteOk,
      detail: remoteOk
        ? "origin is accessible"
        : remote.stderr.toString().trim() || "git ls-remote origin failed",
    },
    {
      name: "gh CLI",
      ok: ghOk,
      detail: ghOk ? gh.stdout.toString().split("\n")[0]!.trim() : gh.stderr.toString().trim() || "gh is unavailable",
    },
    {
      name: "working tree",
      ok: clean || dirtyAudited,
      detail: clean
        ? "clean"
        : dirtyAudited
          ? `dirty tree accepted after audit: ${dirtyReason}`
          : `${changedFiles.length} changed file(s); audit them or clean the tree before retrying`,
    },
  ];
  const ok = checks.every((check) => check.ok);
  return {
    output: {
      ok,
      checks,
      working_tree: {
        clean,
        changed_files: changedFiles,
        untracked_files: untrackedFiles,
        audited: dirtyAudited,
        ...(dirtyAudited ? { audit_reason: dirtyReason } : {}),
      },
    },
    content: checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`).join("\n"),
  };
}

async function runProbe(
  runtime: SwarmxRuntime,
  args: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const root = await canonicalProjectRoot("swarm_probe", runtime);
  const command = String(args.command ?? "");
  if (command.length === 0) {
    throw new LocalToolError("swarm_probe", "invalid_input", "command must be non-empty");
  }
  const result = Bun.spawnSync(["sh", "-c", command], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  const ok = result.exitCode === 0;
  return {
    output: { ok, exit_code: result.exitCode, stdout, stderr },
    content: `probe exit=${result.exitCode}\\n${stdout}${stderr ? "\\n" + stderr : ""}`.trim(),
  };
}

/** Read-only native audit: attempts derive from units; orphans are counted, never repaired. */
async function nativeAudit(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  native: NonNullable<SwarmxRuntime["workUnit"]>,
): Promise<{ result: MissionAudit; sessionID: string; mission: MissionState | undefined; cells: MissionCellSnapshot[] }> {
  const tool = "swarm_agent_audit";
  const projectID = resolveProjectID(runtime);
  const sessionID = resolveSessionID(runtime, context);
  if (projectID === undefined) throw new LocalToolError(tool, "runtime_unavailable", "project id is not wired");
  if (sessionID === undefined) throw new LocalToolError(tool, "runtime_unavailable", "no session id in the tool context");
  const row = await getMission(native.db, projectID, sessionID);
  if (row === null) {
    return { result: { active: false, attempts: [], pendingOrphans: 0 }, sessionID, mission: undefined, cells: [] };
  }
  const units = await listUnits(native.db, row.id);
  const mission = projectMission({ mission: row, units, assignments: [] });
  const result: MissionAudit = {
    active: mission.active,
    mode: mission.mode,
    budget: mission.budget,
    counts: mission.counts,
    attempts: units.map((unit) => unitAttempt(row, unit)),
    pendingOrphans: nativeOrphanCandidates(runtime, units).length,
    ...(mission.consolidation === undefined ? {} : { consolidation: mission.consolidation }),
  };
  const cells = isLiveMission(row) ? await native.store.loadCells(projectID, sessionID) : [];
  return { result, sessionID, mission, cells };
}

async function runAgentAudit(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  let result: MissionAudit;
  let sessionID: string;
  let mission: MissionState | undefined;
  let cells: MissionCellSnapshot[];
  ({ result, sessionID, mission, cells } = await nativeAudit(
    runtime,
    context,
    requireWorkUnitRuntime("swarm_agent_audit", runtime),
  ));
  const summary = selectMissionSummary(mission);
  const readyCells = selectReadyCells(cells);
  const workerSpawns = result.attempts.filter((attempt) => isSwarmWorkerAgentID(attempt.agent)).length;
  const spawns = result.counts?.spawns ?? 0;
  const workerShare = spawns > 0 ? workerSpawns / spawns : 0;
  const consolidation = result.consolidation;
  const lines = [
    result.active
      ? `Mission active — mode=${result.mode} spawns=${spawns}`
      : "No active mission for this session.",
    `cells: ${cells.length} (ready ${readyCells.length})`,
    `swarm-worker spawns: ${workerSpawns} (${Math.round(workerShare * 100)}%)`,
    `attempts: ${result.attempts.length}, pending orphan candidates: ${result.pendingOrphans}`,
    ...(consolidation === undefined
      ? []
      : [
          `consolidation: ${consolidation.status} — cell ${consolidation.cellID}${consolidation.status === "completed" ? "" : " (dispatch the prompt, then mark it completed)"}`,
        ]),
  ];
  return {
    output: {
      ...result,
      sessionID,
      summary: summary ?? null,
      cells,
      readyCells,
      workerSpawns,
      workerShare,
      // Projected shape so the coordinator sees only what it must act on.
      consolidation:
        consolidation === undefined
          ? null
          : {
              status: consolidation.status,
              cellID: consolidation.cellID,
              epicID: consolidation.epicID,
              ...(consolidation.prompt === undefined ? {} : { prompt: consolidation.prompt }),
            },
    },
    content: lines.join("\n"),
  };
}

async function executeLocal(
  spec: ToolSpec,
  runtime: SwarmxRuntime,
  input: unknown,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const args = asArguments(input);
  switch (spec.name) {
    case "swarm_roster":
      return runRoster(runtime, context);
    case "swarm_resolve_agent":
      return runResolveAgent(runtime, context, args);
    case "swarm_set_agent":
      return runSetAgent(runtime, context, args);
    case "swarm_subtask_prompt":
      return runSubtaskPrompt(runtime, args, context);
    case "swarm_set_budget":
      return runSetBudget(runtime, context, args);
    case "swarm_finish":
      return runFinish(runtime, context, args);
    case "swarm_mission_status":
      return runMissionStatus(runtime, context);
    case "swarm_cancel_completion":
      return runCancelCompletion(runtime, context, args);
    case "swarm_amend_completion":
      return runAmendCompletion(runtime, context, args);
    case "swarm_reset":
      return runReset(runtime, context);
    case "swarm_repo_inventory":
      return runRepoInventory(runtime, context);
    case "swarm_preflight":
      return runPreflight(runtime, args);
    case "swarm_probe":
      return runProbe(runtime, args);
    case "swarm_agent_audit":
      return runAgentAudit(runtime, context);
    default:
      throw new LocalToolError(
        spec.name,
        "runtime_unavailable",
        "no handler is registered for this local tool",
      );
  }
}

function isWithinProject(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function validateReviewScope(
  runtime: SwarmxRuntime,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projectRoot = await validateProjectRoot(runtime, "swarm_review", input.project_key);
  return validateProjectFiles(runtime, "swarm_review", input, projectRoot);
}

/** Stale plugin copy: `.opencode1/...` must never be treated as the active project. */
const STALE_PLUGIN_COPY_PREFIX = ".opencode1";

/**
 * Rejects ambiguous project-key shapes before any filesystem resolution.
 *
 * Mixed separators (`/` and `\`) and stale `.opencode1` copies are refused so a
 * mission can never be scoped to a half-copied plugin tree.
 */
function assertProjectKeyShape(tool: string, projectKey: string): void {
  if (projectKey.includes("/") && projectKey.includes("\\")) {
    throw new LocalToolError(tool, "invalid_input", "project_key must not mix path separators");
  }
  const segments = projectKey.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment.toLowerCase().startsWith(STALE_PLUGIN_COPY_PREFIX))) {
    throw new LocalToolError(tool, "conflict", "project_key must not point at a stale .opencode1 copy");
  }
}

function stripTrailingSeparators(value: string): string {
  const stripped = value.replace(/[\\/]+$/, "");
  return stripped.length === 0 ? value : stripped;
}

/**
 * Resolves the active project root to its real path.
 *
 * Review, completion and mission-scope receipts all store this value, so a
 * symlinked or non-canonical wiring cannot leak into persisted state. Returns
 * `undefined` when the host wires no root (or a non-filesystem fixture path);
 * rejected shapes still throw.
 */
async function resolveProjectRoot(tool: string, runtime: SwarmxRuntime): Promise<string | undefined> {
  if (typeof runtime.projectPath !== "string" || runtime.projectPath.trim().length === 0) {
    return undefined;
  }
  const declared = runtime.projectPath.trim();
  assertProjectKeyShape(tool, declared);
  const projectRoot = await realpath(declared).catch(() => undefined);
  if (projectRoot === undefined) return undefined;
  assertProjectKeyShape(tool, projectRoot);
  return projectRoot;
}

async function canonicalProjectRoot(tool: string, runtime: SwarmxRuntime): Promise<string> {
  const projectRoot = await resolveProjectRoot(tool, runtime);
  if (projectRoot === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "active project root is not wired");
  }
  return projectRoot;
}

async function validateProjectRoot(
  runtime: SwarmxRuntime,
  tool: string,
  projectKey: unknown,
): Promise<string> {
  try {
    return await resolveCanonicalProjectKey(runtime, tool, projectKey);
  } catch (error) {
    // Every refusal means the caller tried to scope the mission outside the
    // canonical root: record it before rethrowing. A wiring failure is not a
    // caller attempt, so it stays out of the audit log.
    if (error instanceof LocalToolError && error.code !== "runtime_unavailable") {
      emitViolation(runtime.sessionEvents, {
        sessionID: runtimeSessionID(runtime),
        violationType: "non_canonical_project_key",
        payload: {
          tool,
          code: error.code,
          project_key: typeof projectKey === "string" ? projectKey : null,
        },
      });
    }
    throw error;
  }
}

async function resolveCanonicalProjectKey(
  runtime: SwarmxRuntime,
  tool: string,
  projectKey: unknown,
): Promise<string> {
  const projectRoot = await canonicalProjectRoot(tool, runtime);
  if (typeof projectKey !== "string" || projectKey.trim().length === 0) {
    throw new LocalToolError(tool, "invalid_input", "project_key must identify the active project root");
  }
  const requested = projectKey.trim();
  // Normalize benign variants (bare project name) to the canonical root instead
  // of rejecting them. Only genuinely different roots (or malformed shapes such
  // as trailing separators / dot segments) still raise non_canonical.
  const shapeIsClean =
    stripTrailingSeparators(requested) === requested &&
    !requested.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
  // Only normalize truly bare project names (no path separators) to the
  // canonical root. Paths — even ones whose final segment matches — keep going
  // through the strict validation below so malformed shapes are still rejected.
  if (
    shapeIsClean &&
    !/[\\/]/.test(requested) &&
    requested.toLowerCase() === basename(projectRoot).toLowerCase() &&
    !isAbsolute(requested)
  ) {
    return projectRoot;
  }
  assertProjectKeyShape(tool, requested);

  if (isAbsolute(requested)) {
    // Canonical means: no trailing separator and no `.`/`..` segments.
    if (
      stripTrailingSeparators(requested) !== requested ||
      requested.split(/[\\/]+/).some((segment) => segment === "." || segment === "..")
    ) {
      throw new LocalToolError(tool, "invalid_input", "project_key must be the canonical active project root");
    }
  }

  const requestedRoot = await realpath(resolve(projectRoot, requested)).catch(() => undefined);
  if (requestedRoot === undefined) {
    throw new LocalToolError(tool, "not_found", "project_key must name the active project root");
  }
  // Allow nested git repositories under the workspace root (multi-repo setups).
  // A nested repo is accepted when it contains a .git directory and is under
  // the workspace root.
  if (requestedRoot !== projectRoot) {
    const isNestedRepo =
      requestedRoot.startsWith(projectRoot + sep) &&
      (await stat(resolve(requestedRoot, ".git")).catch(() => undefined)) !== undefined;
    if (!isNestedRepo) {
      throw new LocalToolError(tool, "conflict", "project_key must name the active project root");
    }
    return requestedRoot;
  }
  return projectRoot;
}

async function validateProjectFiles(
  runtime: SwarmxRuntime,
  tool: string,
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  // Allow empty/absent files_touched for no-file tasks (research, analysis).
  if (!Array.isArray(input.files_touched) || input.files_touched.length === 0) {
    return { ...input, project_key: projectRoot, files_touched: [] };
  }

  const filesTouched: string[] = [];
  for (const entry of input.files_touched) {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry !== entry.trim()) {
      throw new LocalToolError(tool, "invalid_input", "files_touched must contain repo-relative file paths");
    }
    const file = entry.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
    const segments = file.split("/");
    const pathspecCharacters = ["*", "?", "[", "]", ":", "!", "^"];
    if (
      file.length === 0 ||
      file.startsWith("/") ||
      /^[a-z]:/i.test(file) ||
      /[\u0000-\u001f\u007f]/.test(file) ||
      !/^[A-Za-z0-9._/@+-]+$/.test(file) ||
      pathspecCharacters.some((character) => file.includes(character)) ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new LocalToolError(
        tool,
        "invalid_input",
        "files_touched must contain portable repo-relative file paths without pathspec syntax",
      );
    }

    const targetPath = resolve(projectRoot, ...segments);
    let target: string;
    try {
      target = await realpath(targetPath);
    } catch (error) {
      const directoryEntry = await lstat(targetPath).catch(() => undefined);
      if (directoryEntry !== undefined || !hasNodeErrorCode(error, "ENOENT")) {
        throw new LocalToolError(
          tool,
          "invalid_input",
          "files_touched must not resolve through symlinks or outside the active project",
        );
      }
      const parent = await realpath(dirname(targetPath)).catch(() => undefined);
      if (parent === undefined || (parent !== projectRoot && !isWithinProject(projectRoot, parent))) {
        throw new LocalToolError(tool, "not_found", "files_touched entries must stay inside the active project");
      }
      filesTouched.push(segments.join("/"));
      continue;
    }
    if (!isWithinProject(projectRoot, target) || !(await stat(target)).isFile()) {
      throw new LocalToolError(
        tool,
        "invalid_input",
        "files_touched must contain only regular files inside the active project",
      );
    }
    filesTouched.push(segments.join("/"));
  }

  return { ...input, project_key: projectRoot, files_touched: filesTouched };
}

/**
 * One step of the completion gate, as returned by the `swarm_complete` backend
 * (`verification_gate.steps`). Snapshotted verbatim so the approval evidence
 * can be re-read without asking the backend again.
 */
interface VerificationGateStep {
  readonly name: string;
  readonly passed: boolean;
  readonly skipped?: boolean;
  readonly skipReason?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly output?: string;
}

/**
 * Receipt produced by the completion verification gate (`tsc` + related tests)
 * that the backend returns alongside a successful `swarm_complete`.
 *
 * Approval evidence, never a bypass: `passed` is the literal `true` so a
 * skipped gate (`{skipped:true}`) or a hollow payload can never satisfy it.
 */
interface VerificationGateReceipt {
  readonly passed: true;
  readonly summary: string;
  readonly steps: readonly VerificationGateStep[];
  readonly recordedAt: number;
}

/** Audit trail persisted in the scoped review receipt when a cell is approved. */
function isVerificationGateReceipt(value: unknown): value is VerificationGateReceipt {
  const record = asArguments(value);
  return (
    record.passed === true &&
    typeof record.summary === "string" &&
    typeof record.recordedAt === "number" &&
    Array.isArray(record.steps) &&
    record.steps.length > 0 &&
    record.steps.some((step) => asArguments(step).skipped !== true) &&
    record.steps.every((step) => {
      const entry = asArguments(step);
      return entry.skipped === true || entry.passed === true;
    }) &&
    record.steps.every((step) => {
      const entry = asArguments(step);
      return (
        typeof entry.name === "string" &&
        typeof entry.passed === "boolean" &&
        (entry.skipped === undefined || typeof entry.skipped === "boolean") &&
        (entry.skipReason === undefined || typeof entry.skipReason === "string") &&
        (entry.command === undefined || typeof entry.command === "string") &&
        (entry.exitCode === undefined || typeof entry.exitCode === "number") &&
        (entry.output === undefined || typeof entry.output === "string")
      );
    })
  );
}

/** Paths that are documentation or static assets (no typecheck/tests apply). */
function isDocOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  if (lower.endsWith(".md")) return true;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.includes("assets") || segments.includes("docs");
}

function parseBackendObject(output: unknown): Record<string, unknown> {
  if (typeof output === "string") {
    try {
      return asArguments(JSON.parse(output) as unknown);
    } catch {
      return {};
    }
  }
  return asArguments(output);
}

function parseWorkerVerification(value: unknown): VerificationGateReceipt | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const steps: VerificationGateStep[] = [];
  for (const raw of value) {
    const step = asArguments(raw);
    if (
      typeof step.name !== "string" ||
      typeof step.command !== "string" ||
      typeof step.exit_code !== "number" ||
      typeof step.output !== "string"
    ) {
      return undefined;
    }
    steps.push({
      name: step.name,
      command: step.command,
      exitCode: step.exit_code,
      output: step.output,
      passed: step.exit_code === 0,
    });
  }
  if (!steps.every((step) => step.passed)) return undefined;
  return {
    passed: true,
    summary: `Worker reported ${steps.length} verification step(s) passed`,
    steps,
    recordedAt: Date.now(),
  };
}

function runToolForSession(
  runtime: SwarmxRuntime,
  name: string,
  args: Record<string, unknown>,
  sessionID: string,
  timeoutMs?: number,
  cwd?: string,
): Promise<unknown> {
  return runtime.runTool(name, args, {
    ...(cwd === undefined && runtime.projectPath === undefined ? {} : { cwd: cwd ?? runtime.projectPath }),
    env: { OPENCODE_SESSION_ID: sessionID },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

interface GitDiffSection {
  readonly oldPath: string;
  readonly newPath: string;
  readonly lines: readonly string[];
}

function parseGitDiffSections(diff: string): GitDiffSection[] | undefined {
  const sections: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      sections.push([line]);
    } else {
      const current = sections.at(-1);
      if (current === undefined) {
        if (line.trim().length > 0) return undefined;
      } else {
        current.push(line);
      }
    }
  }

  const parsed: GitDiffSection[] = [];
  for (const lines of sections) {
    const header = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(lines[0] ?? "");
    if (header === null) return undefined;
    parsed.push({ oldPath: header[1] ?? "", newPath: header[2] ?? "", lines });
  }
  return parsed;
}

function hasCompleteDiffChange(section: readonly string[]): boolean {
  let hasHunk = false;
  let changedLines = 0;
  let index = 0;
  while (index < section.length) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(section[index] ?? "");
    if (hunk === null) {
      index += 1;
      continue;
    }
    hasHunk = true;
    const expectedOld = Number(hunk[1] ?? 1);
    const expectedNew = Number(hunk[2] ?? 1);
    let actualOld = 0;
    let actualNew = 0;
    index += 1;
    while (index < section.length && !section[index]?.startsWith("@@ ")) {
      const line = section[index] ?? "";
      if (line.startsWith("\\")) {
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        actualOld += 1;
        actualNew += 1;
      } else if (line.startsWith("-")) {
        actualOld += 1;
        changedLines += 1;
      } else if (line.startsWith("+")) {
        actualNew += 1;
        changedLines += 1;
      } else {
        return false;
      }
      index += 1;
    }
    if (actualOld !== expectedOld || actualNew !== expectedNew) return false;
  }
  if (hasHunk) return changedLines > 0;
  return section.some((line) =>
    /^(?:Binary files .* differ|GIT binary patch|new file mode \d+|deleted file mode \d+|old mode \d+|new mode \d+|rename from |rename to |copy from |copy to |similarity index |dissimilarity index )/.test(
      line,
    ),
  );
}

type ScopedReviewDiffCheck =
  | { readonly ok: true; readonly diff: string }
  | { readonly ok: false; readonly missing: "diff" | "file" | "empty_file" };

/**
 * Verifies the backend review output carries a **non-empty scoped diff for
 * every** `files_touched` entry.
 *
 * Failure modes are distinguished so callers can report the actual gap:
 *   - `diff`: no prompt/diff section, `(no diff available)`, unparsable diff;
 *   - `file`: the diff does not cover exactly the requested file list, or one
 *     requested file has no section at all;
 *   - `empty_file`: a section is header-only / has no complete change hunk.
 */
function generateNewFileDiff(file: string, projectRoot?: string): string {
  const cwd = projectRoot ?? process.cwd();
  if (!existsSync(resolve(cwd, file))) return "";
  try {
    // Run with a project-relative path so git emits `a/<file> b/<file>` headers
    // regardless of whether cwd sits inside a git repository.
    const result = Bun.spawnSync(["git", "diff", "--no-index", "--", "/dev/null", file], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString().trim();
  } catch {
    return "";
  }
}

function enrichReviewOutputWithNewFiles(
  output: unknown,
  filesTouched: readonly string[],
  projectRoot?: string,
): unknown {
  const record = parseBackendObject(output);
  if (typeof record.review_prompt !== "string") return output;
  const returned = asArguments(record.context).files_touched;
  const returnedList = Array.isArray(returned) ? (returned as string[]) : [];
  const missing = filesTouched.filter((file) => !returnedList.includes(file));
  const diffs = missing
    .map((file) => generateNewFileDiff(file, projectRoot))
    .filter((diff) => diff.length > 0);
  if (diffs.length === 0) return output;

  const endMarker = "\n```\n\n## Review Criteria";
  let reviewPrompt = record.review_prompt;
  const filesHeader = "## Files Modified\n";
  if (reviewPrompt.includes(filesHeader)) {
    reviewPrompt = reviewPrompt.replace(
      filesHeader,
      `${filesHeader}${missing.map((file) => `- \`${file}\``).join("\n")}\n`,
    );
  } else {
    reviewPrompt = `${filesHeader}${missing.map((file) => `- \`${file}\``).join("\n")}\n\n${reviewPrompt}`;
  }
  reviewPrompt = reviewPrompt.includes(endMarker)
    ? reviewPrompt.replace(endMarker, `\n${diffs.join("\n")}${endMarker}`)
    : `${reviewPrompt}\n\n## New Files\n\`\`\`diff\n${diffs.join("\n")}\n\`\`\``;
  return {
    ...record,
    review_prompt: reviewPrompt,
    context: {
      ...(typeof record.context === "object" && record.context !== null ? record.context : {}),
      files_touched: [...missing, ...returnedList],
    },
  };
}

function checkScopedReviewDiff(
  output: unknown,
  filesTouched: readonly string[],
  projectRoot?: string,
): ScopedReviewDiffCheck {
  // No-file tasks: nothing to diff or verify; the review is vacuously complete.
  if (filesTouched.length === 0) {
    return { ok: true, diff: "" };
  }
  const record = parseBackendObject(output);
  // If the backend could not produce a review_prompt (e.g. untracked files
  // outside any repo), accept the review as long as every declared file exists
  // on disk. The coordinator can read the file directly.
  if (typeof record.review_prompt !== "string") {
    const allExist = filesTouched.every((file) => {
      const fullPath = projectRoot ? resolve(projectRoot, file) : file;
      return existsSync(fullPath);
    });
    if (allExist) {
      return { ok: true, diff: "" };
    }
    return { ok: false, missing: "diff" };
  }
  const returnedFiles = asArguments(record.context).files_touched;
  const returnedList = Array.isArray(returnedFiles) ? (returnedFiles as string[]) : [];

  // The backend only returns tracked files that have a git diff. Files that are
  // new (untracked or outside any repo) have no diff and are absent from
  // returnedFiles. Accept them as long as they exist on disk.
  const missingFromBackend = filesTouched.filter((f) => !returnedList.includes(f));
  if (returnedList.some((f) => !filesTouched.includes(f))) {
    return { ok: false, missing: "file" };
  }
  let newFileDiff = "";
  for (const file of missingFromBackend) {
    const fullPath = projectRoot ? resolve(projectRoot, file) : file;
    if (!existsSync(fullPath)) {
      return { ok: false, missing: "file" };
    }
    // Generate a diff for new (untracked) files so the reviewer sees content.
    const generated = generateNewFileDiff(file, projectRoot);
    if (generated.length > 0) {
      newFileDiff += (newFileDiff.length > 0 ? "\n" : "") + generated;
    }
  }

  const prompt = record.review_prompt;
  const filesStart = prompt.indexOf("## Files Modified\n");
  const codeStart = prompt.indexOf("\n## Code Changes\n", filesStart);

  let diff = "";
  // If the backend returned a diff (tracked files present), validate its
  // structure for those files only.
  if (returnedList.length > 0) {
    if (filesStart < 0 || codeStart < 0) {
      const allExist = filesTouched.every((file) => {
        const fullPath = projectRoot ? resolve(projectRoot, file) : file;
        return existsSync(fullPath);
      });
      if (allExist) return { ok: true, diff: "" };
      return { ok: false, missing: "diff" };
    }
    const fileSection = prompt.slice(filesStart, codeStart);
    const listedFiles = [...fileSection.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
    if (
      listedFiles.length !== returnedList.length ||
      !listedFiles.every((file, index) => file === returnedList[index])
    ) {
      return { ok: false, missing: "file" };
    }

    const diffStartMarker = "## Code Changes\n```diff\n";
    const diffEndMarker = "\n```\n\n## Review Criteria";
    const diffStart = prompt.indexOf(diffStartMarker, codeStart);
    const diffEnd = prompt.indexOf(diffEndMarker, diffStart + diffStartMarker.length);
    if (diffStart < 0 || diffEnd < 0) {
      // No diff section at all — accept if all files exist on disk.
      const allExist = filesTouched.every((file) => {
        const fullPath = projectRoot ? resolve(projectRoot, file) : file;
        return existsSync(fullPath);
      });
      if (allExist) return { ok: true, diff: "" };
      return { ok: false, missing: "diff" };
    }
    diff = prompt.slice(diffStart + diffStartMarker.length, diffEnd).trim();
    if (diff.length === 0 || diff.includes("(no diff available)")) {
      // If every declared file exists on disk, accept without a diff (new/untracked
      // files have no git diff). The coordinator can read the file directly.
      const allExist = filesTouched.every((file) => {
        const fullPath = projectRoot ? resolve(projectRoot, file) : file;
        return existsSync(fullPath);
      });
      if (allExist) {
        return { ok: true, diff: "" };
      }
      return { ok: false, missing: "diff" };
    }

    const sections = parseGitDiffSections(diff);
    if (sections === undefined || sections.length === 0) return { ok: false, missing: "diff" };
    if (sections.some((section) => !hasCompleteDiffChange(section.lines))) {
      return { ok: false, missing: "empty_file" };
    }

    const expectedPaths = new Set(returnedList);
    const diffPaths = new Set(sections.flatMap((section) => [section.oldPath, section.newPath]));
    if (
      diffPaths.size !== expectedPaths.size ||
      [...diffPaths].some((file) => !expectedPaths.has(file))
    ) {
      return { ok: false, missing: "file" };
    }
  }

  return { ok: true, diff: diff.length > 0 ? diff : newFileDiff };
}

function scopedDiffFailureMessage(missing: "diff" | "file" | "empty_file"): string {
  return missing === "empty_file"
    ? "backend did not return a non-empty scoped diff for every files_touched entry; approval is blocked"
    : "backend did not return a complete, non-empty scoped diff for every files_touched entry; approval is blocked";
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

const reviewDecisionLocks = new Map<string, Promise<void>>();
const reviewLockContext = new AsyncLocalStorage<ReadonlySet<string>>();

async function withReviewDecisionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const held = reviewLockContext.getStore();
  if (held?.has(key) === true) {
    throw new Error(`reentrant review lock: ${key}`);
  }
  const nextHeld = new Set(held ?? []);
  nextHeld.add(key);
  return reviewLockContext.run(nextHeld, async () => {
    const previous = reviewDecisionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    reviewDecisionLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (reviewDecisionLocks.get(key) === current) reviewDecisionLocks.delete(key);
    }
  });
}

async function executeReviewFeedback(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const native = await requireOpenNativeMission(runtime, context, "swarm_review_feedback");
  const nativeKey = [native.projectID, native.sessionID].map(encodeURIComponent).join(":");
  return withReviewDecisionLock(nativeKey, () => executeNativeReviewFeedback(runtime, context, args));
}

function runLocalVerification(
  projectPath: string,
  filesTouched: readonly string[],
): { passed: boolean; summary: string; steps: Array<Record<string, unknown>> } {
  const steps: Array<Record<string, unknown>> = [];

  const tsconfig = `${projectPath}/tsconfig.json`;
  if (existsSync(tsconfig)) {
    const result = Bun.spawnSync(["bunx", "tsc", "--noEmit"], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    steps.push({ name: "typecheck", passed: result.exitCode === 0, exitCode: result.exitCode });
  } else {
    steps.push({ name: "typecheck", passed: true, skipped: true, skipReason: "No tsconfig.json" });
  }

  const testFiles = filesTouched.filter(
    (file) => file.includes(".test.") || file.includes(".spec."),
  );
  if (testFiles.length > 0) {
    const result = Bun.spawnSync(
      ["bun", "test", ...testFiles.map((file) => `${projectPath}/${file}`)],
      { cwd: projectPath, stdout: "pipe", stderr: "pipe" },
    );
    steps.push({ name: "tests", passed: result.exitCode === 0, exitCode: result.exitCode });
  } else {
    steps.push({ name: "tests", passed: true, skipped: true, skipReason: "No test files" });
  }

  const hasExecutedCheck = steps.some((step) => step.skipped !== true);
  const passed = hasExecutedCheck && steps.every((step) => step.passed === true);
  return {
    passed,
    summary: passed
      ? "Local verification passed"
      : hasExecutedCheck
        ? "Local verification failed"
        : "No local verification checks were executed",
    steps,
  };
}

/** Deduplicated, non-empty file list; `renderSubtaskPrompt` refuses empties. */
function consolidationFiles(files: readonly string[]): string[] {
  const unique = [...new Set(files.map((file) => file.trim()).filter((file) => file.length > 0))];
  return unique.length === 0 ? ["(no specific files — use judgment)"] : unique;
}

/** One epic child as returned by `hive_cells` (read-only projection). */
interface EpicChildCell {
  readonly id: string;
  readonly status: string;
  readonly title?: string;
}

function toEpicChildCell(value: unknown): EpicChildCell | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.status !== "string") return undefined;
  return {
    id: record.id,
    status: record.status,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
  };
}

/** Accepts a JSON string, a bare array or a `{ cells: [...] }` envelope. */
function parseEpicCells(output: unknown): EpicChildCell[] {
  let parsed = output;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return [];
    }
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).cells)
      ? ((parsed as Record<string, unknown>).cells as unknown[])
      : [];
  return rows
    .map(toEpicChildCell)
    .filter((cell): cell is EpicChildCell => cell !== undefined);
}

/** Lists the children of one epic through the backend `hive_cells` tool. */
async function listEpicChildCells(
  runtime: SwarmxRuntime,
  sessionID: string,
  epicID: string,
  projectRoot?: string,
): Promise<EpicChildCell[]> {
  // `parent_id` is a first-class filter of the backend `hive_cells` schema
  // (opencode-swarm-plugin/src/hive.ts: `parent_id` → adapter.queryCells), and
  // the local catalog spec declares it too, so the CLI forwards it verbatim.
  const output = await runToolForSession(
    runtime,
    "hive_cells",
    {
      ...(projectRoot === undefined && runtime.projectPath === undefined
        ? {}
        : { project_key: projectRoot ?? runtime.projectPath }),
      parent_id: epicID,
      limit: 200,
    },
    sessionID,
    60_000,
    projectRoot,
  );
  return parseEpicCells(output);
}

/**
 * Arguments of the `hive_create` call that persists the consolidation cell.
 *
 * `parent_id` is mandatory: the consolidation cell must be a child of the epic
 * it consolidates, otherwise it is an orphan in the hive tree and never shows
 * up in `hive_cells({ parent_id: epicID })`.
 */
export function consolidationCreateArgs(input: {
  readonly title: string;
  readonly description: string;
  readonly epicID: string;
}): Record<string, unknown> {
  return {
    title: input.title,
    type: "task",
    description: input.description,
    parent_id: input.epicID,
  };
}

/**
 * Creates, assigns and starts the consolidation cell, then renders its prompt.
 *
 * The plugin cannot spawn: it prepares the cell so the coordinator only has to
 * dispatch the returned prompt once.
 */
async function prepareConsolidationCell(
  runtime: SwarmxRuntime,
  assign: (cellID: string) => Promise<unknown>,
  scope: {
    readonly projectID: string;
    readonly sessionID: string;
    readonly epicID: string;
    readonly files: readonly string[];
  },
  cells: readonly EpicChildCell[],
): Promise<{ readonly cellID: string; readonly prompt: string }> {
  const title = `Consolidate ${scope.epicID}`;
  const description = [
    `Merge, summarize and verify the work of epic ${scope.epicID}.`,
    "",
    "Approved cells:",
    ...cells.map(
      (cell) =>
        `- ${cell.id}${cell.title === undefined ? "" : `: ${cell.title}`} (${cell.status})`,
    ),
    "",
    "Re-run the affected tests and report the final verification.",
  ].join("\n");
  const files = consolidationFiles(scope.files);

  const created = await runToolForSession(
    runtime,
    "hive_create",
    consolidationCreateArgs({ title, description, epicID: scope.epicID }),
    scope.sessionID,
    60_000,
  );
  const cellID = parseBackendObject(created).id;
  if (typeof cellID !== "string" || cellID.length === 0) {
    throw new LocalToolError(
      "swarm_review_feedback",
      "runtime_unavailable",
      "hive_create returned no consolidation cell id",
    );
  }
  await assign(cellID);
  try {
    await runToolForSession(runtime, "hive_start", { id: cellID }, scope.sessionID, 60_000);
  } catch {
    // Best effort: the coordinator can start the cell before dispatching it.
  }

  const prompt = renderSubtaskPrompt({
    cellID,
    epicID: scope.epicID,
    agent: SWARM_WORKER_AGENT_ID,
    title,
    description,
    files,
    ...(runtime.workerProtocol === undefined ? {} : { protocol: runtime.workerProtocol }),
  });
  return { cellID, prompt };
}

// ---------------------------------------------------------------------------
// Native WorkUnit completion / review / cancel / finish routing (Task 13d2).
// Writes go through actor-checked MissionCommands only; reads use listUnits/getMission.
// ---------------------------------------------------------------------------

const NATIVE_TERMINAL_STATES: ReadonlySet<WorkUnit["state"]> = new Set([
  "DONE", "CHANGES_REQUESTED", "REJECTED", "CANCELLED", "ABANDONED", "REVOKED", "FAILED",
]);
const NATIVE_PENDING_COMPLETION_STATES: ReadonlySet<WorkUnit["state"]> = new Set([
  "SUBMITTED", "IN_REVIEW", "APPROVED", "PUBLISHING", "RETURNING",
]);

interface NativeEvidence {
  readonly filesTouched: string[];
  readonly summary: string;
  readonly startTime: number;
  readonly projectPath: string;
  readonly epicID: string;
  readonly workerAgentName: string;
  readonly verification?: VerificationGateReceipt;
}

function nativeEvidence(unit: WorkUnit): NativeEvidence | undefined {
  if (unit.evidence_json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unit.evidence_json);
  } catch {
    return undefined;
  }
  const record = asArguments(parsed);
  if (
    !Array.isArray(record.filesTouched) ||
    typeof record.summary !== "string" ||
    typeof record.startTime !== "number" ||
    typeof record.projectPath !== "string" ||
    typeof record.epicID !== "string" ||
    typeof record.workerAgentName !== "string"
  ) {
    return undefined;
  }
  return {
    filesTouched: record.filesTouched.filter((file): file is string => typeof file === "string"),
    summary: record.summary,
    startTime: record.startTime,
    projectPath: record.projectPath,
    epicID: record.epicID,
    workerAgentName: record.workerAgentName,
    ...(isVerificationGateReceipt(record.verification) ? { verification: record.verification } : {}),
  };
}

function nativeConflict(tool: string, error: unknown): LocalToolError {
  if (error instanceof LocalToolError) return error;
  return new LocalToolError(tool, "conflict", error instanceof Error ? error.message : String(error));
}

async function requireOpenNativeMission(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  tool: string,
): Promise<WorkUnitMissionScope> {
  const scope = await requireWorkUnitMissionScope(tool, runtime, context);
  if (scope.mission.state !== "OPEN") {
    throw new LocalToolError(tool, "not_found", "an active swarmx mission is required");
  }
  return scope;
}

/** Latest (highest attempt) unit of a cell in the mission. */
function latestCellUnit(units: readonly WorkUnit[], cellID: string): WorkUnit | undefined {
  return units
    .filter((unit) => unit.cell_id === cellID)
    .sort((left, right) => right.attempt_no - left.attempt_no)[0];
}

async function nativeWorkerUnit(
  runtime: SwarmxRuntime,
  worker: AssignedWorkerScope,
  tool: string,
): Promise<{ readonly unit: WorkUnit; readonly workUnit: NonNullable<SwarmxRuntime["workUnit"]> }> {
  const workUnit = runtime.workUnit;
  const projectID = resolveProjectID(runtime);
  if (workUnit === undefined || projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "WorkUnit runtime is not wired");
  }
  const mission = await getMission(workUnit.db, projectID, worker.parentMission.sessionID);
  const unit = mission === null
    ? undefined
    : (await listUnits(workUnit.db, mission.id)).find((candidate) => candidate.call_id === worker.attemptCallID);
  if (unit === undefined) {
    throw new LocalToolError(tool, "conflict", "the worker dispatch has no WorkUnit in its parent mission");
  }
  return { unit, workUnit };
}

async function submitNativeCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
  worker: AssignedWorkerScope,
): Promise<ToolExecuteResult> {
  if (context.sessionID === undefined) {
    throw new LocalToolError("swarm_complete", "runtime_unavailable", "worker session is not available");
  }
  const { unit, workUnit } = await nativeWorkerUnit(runtime, worker, "swarm_complete");
  const startTime = typeof args.start_time === "number" ? args.start_time : Date.now();
  const verification = parseWorkerVerification(args.verification);
  const filesTouched = Array.isArray(args.files_touched) ? (args.files_touched as string[]) : [];
  const evidence = {
    filesTouched,
    summary: args.summary as string,
    startTime,
    projectPath: typeof args.project_key === "string" ? args.project_key : await canonicalProjectRoot("swarm_complete", runtime),
    epicID: worker.marker.epicID,
    workerAgentName: worker.agent.name,
    // recordedAt is pinned so an identical replay hashes to the same evidence.
    ...(verification === undefined ? {} : { verification: { ...verification, recordedAt: startTime } }),
  };
  try {
    await workUnit.commands.submit({ kind: "worker", sessionId: context.sessionID }, { unitId: unit.id, evidence });
  } catch (error) {
    throw nativeConflict("swarm_complete", error);
  }
  return {
    output: {
      success: true,
      status: "pending_review",
      bead_id: worker.marker.cellID,
      files_touched: filesTouched,
      message: "Completion submitted; the coordinator must review the scoped diff before finalization.",
    },
    content: `Completion for ${worker.marker.cellID} submitted; awaiting coordinator review.`,
  };
}

function amendableFiles(
  projectPath: string,
  requested: readonly string[],
): { effective: string[]; excluded: Array<{ file: string; reason: string }> } {
  const effective: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  for (const file of requested) {
    const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", file], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tracked.exitCode !== 0) {
      excluded.push({ file, reason: "untracked" });
      continue;
    }
    const diff = Bun.spawnSync(["git", "diff", "HEAD", "--", file], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (diff.stdout.toString().trim().length === 0) {
      excluded.push({ file, reason: "no diff" });
      continue;
    }
    effective.push(file);
  }
  return { effective, excluded };
}

async function runNativeAmendCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
  worker: AssignedWorkerScope,
  beadID: string,
  reason: string,
): Promise<ToolExecuteResult> {
  const { unit, workUnit } = await nativeWorkerUnit(runtime, worker, "swarm_amend_completion");
  const evidence = nativeEvidence(unit);
  if (
    context.sessionID === undefined ||
    unit.cell_id !== beadID ||
    unit.state !== "SUBMITTED" ||
    unit.worker_session !== context.sessionID ||
    evidence === undefined
  ) {
    throw new LocalToolError("swarm_amend_completion", "conflict", "no amendable pending completion for this worker");
  }
  const validated = await validateProjectFiles(
    runtime,
    "swarm_amend_completion",
    { ...input, project_key: evidence.projectPath },
    evidence.projectPath,
  );
  const { effective, excluded } = amendableFiles(evidence.projectPath, validated.files_touched as string[]);
  try {
    await workUnit.commands.amendCompletion(
      { kind: "worker", sessionId: context.sessionID },
      { unitId: unit.id, filesTouched: effective, reason },
    );
  } catch (error) {
    throw nativeConflict("swarm_amend_completion", error);
  }
  return {
    output: { bead_id: beadID, files_touched: effective, excluded, reason },
    content: `Amended ${beadID}: effective files=${effective.length}, excluded=${excluded.length}`,
  };
}

async function runNativeCancelCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const scope = await requireWorkUnitMissionScope("swarm_cancel_completion", runtime, context);
  const beadID = requireStringInput("swarm_cancel_completion", input, "bead_id");
  const reason = requireStringInput("swarm_cancel_completion", input, "reason");
  if (scope.mission.state !== "OPEN") {
    throw new LocalToolError("swarm_cancel_completion", "not_found", "no active mission");
  }
  const unit = latestCellUnit(await listUnits(scope.runtime.db, scope.mission.id), beadID);
  if (unit === undefined || !(unit.state === "SUBMITTED" || (unit.state === "CANCELLED" && unit.reason === reason))) {
    throw new LocalToolError("swarm_cancel_completion", "not_found", "no pending completion for this cell in the active mission");
  }
  try {
    await scope.runtime.commands.cancelCompletion(
      { kind: "coordinator", sessionId: scope.sessionID },
      { unitId: unit.id, reason },
    );
  } catch (error) {
    throw nativeConflict("swarm_cancel_completion", error);
  }
  return {
    output: { bead_id: beadID, canceled: true, reason },
    content: `Pending completion for ${beadID} canceled: ${reason}`,
  };
}

async function recordNativeScopedReview(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
  output: unknown,
): Promise<void> {
  const scope = await requireOpenNativeMission(runtime, context, "swarm_review");
  const projectRoot = await resolveProjectRoot("swarm_review", runtime);
  if (projectRoot === undefined) {
    throw new LocalToolError("swarm_review", "runtime_unavailable", "active project root is not wired");
  }
  const taskID = requireStringInput("swarm_review", args, "task_id");
  const epicID = requireStringInput("swarm_review", args, "epic_id");
  const filesTouched = args.files_touched as string[];
  const check = checkScopedReviewDiff(output, filesTouched, projectRoot);
  if (!check.ok) {
    throw new LocalToolError("swarm_review", "conflict", `${scopedDiffFailureMessage(check.missing)} (${check.missing})`);
  }
  if (filesTouched.length > 0 && check.diff.trim().length === 0) {
    throw new LocalToolError("swarm_review", "conflict", "scoped review diff is empty for the touched files");
  }
  const unit = latestCellUnit(await listUnits(scope.runtime.db, scope.mission.id), taskID);
  const evidence = unit === undefined ? undefined : nativeEvidence(unit);
  if (
    unit === undefined ||
    evidence === undefined ||
    (unit.state !== "SUBMITTED" && unit.state !== "IN_REVIEW") ||
    evidence.epicID !== epicID ||
    !samePaths(effectiveCompletionFiles(unit), filesTouched)
  ) {
    throw new LocalToolError(
      "swarm_review",
      "conflict",
      "review requires the assigned worker's matching completion submission and file list",
    );
  }
  try {
    await scope.runtime.commands.beginReview(
      { kind: "coordinator", sessionId: scope.sessionID },
      { unitId: unit.id, reviewDiffHash: createHash("sha256").update(check.diff).digest("hex") },
    );
  } catch (error) {
    throw nativeConflict("swarm_review", error);
  }
}

function parseNativeConsolidation(json: string | null): ConsolidationState | undefined {
  if (json === null) return undefined;
  try {
    const record = asArguments(JSON.parse(json));
    if (
      typeof record.epicID === "string" &&
      typeof record.cellID === "string" &&
      (record.status === "ready" || record.status === "completed") &&
      typeof record.createdAt === "number"
    ) {
      return record as unknown as ConsolidationState;
    }
  } catch {
    // Malformed consolidation is treated as absent.
  }
  return undefined;
}

/** Native consolidation: prepare once all epic cells are finished, complete when its own cell is approved. */
async function nativeConsolidation(
  runtime: SwarmxRuntime,
  scope: WorkUnitMissionScope,
  input: { readonly taskID: string; readonly epicID: string; readonly files: readonly string[]; readonly agentID: string },
): Promise<ConsolidationState | undefined> {
  const actor = { kind: "coordinator" as const, sessionId: scope.sessionID };
  const mission = await getMission(scope.runtime.db, scope.projectID, scope.sessionID);
  if (mission === null || mission.state !== "OPEN") return undefined;
  const current = parseNativeConsolidation(mission.consolidation_json);
  if (current !== undefined) {
    if (current.cellID !== input.taskID || current.status === "completed") return current;
    const completed: ConsolidationState = { ...current, status: "completed" };
    await scope.runtime.commands.setConsolidation(actor, {
      missionPk: mission.id, expectedFence: Number(mission.fence), consolidation: completed,
    });
    return completed;
  }
  const cells = (await listEpicChildCells(runtime, scope.sessionID, input.epicID))
    .filter((cell) => cell.id !== input.epicID);
  if (cells.length === 0 || cells.some((cell) => !isConsolidationCellFinished(cell.status))) return undefined;
  const prepared = await prepareConsolidationCell(
    runtime,
    (cellID) => scope.runtime.commands.assignCell(actor, { missionPk: mission.id, cellId: cellID, agent: input.agentID }),
    { projectID: scope.projectID, sessionID: scope.sessionID, epicID: input.epicID, files: input.files },
    cells,
  );
  const consolidation: ConsolidationState = {
    epicID: input.epicID,
    cellID: prepared.cellID,
    status: "ready",
    prompt: prepared.prompt,
    createdAt: Date.now(),
  };
  const fresh = await getMission(scope.runtime.db, scope.projectID, scope.sessionID);
  if (fresh === null) return undefined;
  await scope.runtime.commands.setConsolidation(actor, {
    missionPk: fresh.id, expectedFence: Number(fresh.fence), consolidation,
  });
  return consolidation;
}

async function executeNativeReviewFeedback(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const tool = "swarm_review_feedback";
  const scope = await requireOpenNativeMission(runtime, context, tool);
  await validateProjectRoot(runtime, tool, args.project_key);
  const taskID = requireStringInput(tool, args, "task_id");
  const workerID = requireStringInput(tool, args, "worker_id");
  const status = requireStringInput(tool, args, "status");
  const unit = latestCellUnit(await listUnits(scope.runtime.db, scope.mission.id), taskID);
  const evidence = unit === undefined ? undefined : nativeEvidence(unit);
  if (
    unit === undefined ||
    evidence === undefined ||
    unit.state !== "IN_REVIEW" ||
    unit.review_by !== scope.sessionID ||
    (workerID !== unit.worker_agent && workerID !== evidence.workerAgentName)
  ) {
    throw new LocalToolError(tool, "conflict", "a complete scoped review receipt is required before feedback");
  }
  const files = effectiveCompletionFiles(unit);
  let diff = "";
  if (files.length > 0) {
    const currentDiff = await runToolForSession(
      runtime,
      "swarm_review",
      { project_key: evidence.projectPath, epic_id: evidence.epicID, task_id: taskID, files_touched: files },
      scope.sessionID,
      120_000,
    );
    const check = checkScopedReviewDiff(currentDiff, files);
    if (!check.ok) throw new LocalToolError(tool, "conflict", scopedDiffFailureMessage(check.missing));
    diff = check.diff;
  }
  const diffHash = createHash("sha256").update(diff).digest("hex");
  if (unit.review_diff_hash === null || unit.review_diff_hash !== diffHash) {
    throw new LocalToolError(tool, "conflict", "the diff changed after review; request a fresh review before feedback");
  }
  const docOnly = files.every(isDocOnlyPath);
  const approval = status === "approved" || status === "unverifiable";
  let verification = evidence.verification;
  if (approval && verification === undefined && !docOnly) {
    const local = runLocalVerification(evidence.projectPath, files);
    if (local.passed) {
      verification = { passed: true, summary: local.summary, steps: local.steps, recordedAt: Date.now() } as unknown as VerificationGateReceipt;
    }
  }
  if (approval && verification === undefined && !docOnly) {
    throw new LocalToolError(tool, "conflict", "a completion verification receipt is required before review approval");
  }
  const unverifiable = approval && verification === undefined;
  const reviewStatus = unverifiable ? "unverifiable" : (status as "approved" | "unverifiable" | "needs_changes" | "rejected");
  const workerSessionID = unit.worker_session ?? undefined;
  scope.runtime.createEffectPorts({
    runTool: (name, toolArgs) =>
      name === "swarm_complete" && workerSessionID !== undefined
        ? runToolForSession(runtime, name, toolArgs, workerSessionID, 120_000, evidence.projectPath)
        : runToolForSession(runtime, name, toolArgs, scope.sessionID, 120_000),
  } as Pick<SwarmxRuntime, "runTool">);
  let result;
  try {
    result = await scope.runtime.commands.review({ kind: "coordinator", sessionId: scope.sessionID }, {
      unitId: unit.id,
      status: reviewStatus,
      ...(approval && verification !== undefined
        ? { receipt: { verification, diff_hash: diffHash, files_touched: files } }
        : {}),
      ...(status === "needs_changes" && args.issues !== undefined ? { feedback: args.issues } : {}),
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      summary: evidence.summary,
      projectPath: evidence.projectPath,
      completionArgs: {
        project_key: evidence.projectPath,
        start_time: evidence.startTime,
        files_touched: files,
        skip_review: true,
      },
    });
  } catch (error) {
    throw nativeConflict(tool, error);
  }
  const effect = result.effects.find((candidate) =>
    candidate.kind === (approval ? "backend_complete" : "backend_feedback"));
  const approvalWarning = unverifiable
    ? "Verification receipt unavailable; approved as unverifiable (documentation/assets only)."
    : undefined;
  let consolidation: ConsolidationState | undefined;
  let consolidationError: string | undefined;
  if (approval) {
    emitDecision(runtime.sessionEvents, {
      sessionID: scope.sessionID,
      epicID: evidence.epicID,
      decisionType: "review_approved",
      payload: { task_id: taskID, status: reviewStatus, unverifiable, diff_hash: diffHash },
    });
    if (result.unit.state === "DONE") {
      try {
        // Native assignments hold the canonical roster id the dispatch gate binds against.
        const consolidationAgent = (await loadRosterEntries(tool, runtime, context)).find(
          (agent) => agent.id === SWARM_WORKER_AGENT_ID || agent.name === SWARM_WORKER_AGENT_ID,
        )?.id ?? SWARM_WORKER_AGENT_ID;
        consolidation = await nativeConsolidation(runtime, scope, {
          taskID, epicID: evidence.epicID, files, agentID: consolidationAgent,
        });
      } catch (error) {
        consolidationError = error instanceof Error ? error.message : String(error);
      }
      if (consolidation !== undefined) {
        emitDecision(runtime.sessionEvents, {
          sessionID: scope.sessionID,
          epicID: consolidation.epicID,
          decisionType: consolidation.status === "completed" ? "consolidation_completed" : "consolidation_ready",
          payload: { cell_id: consolidation.cellID, status: consolidation.status },
        });
      }
    }
  }
  return {
    output: {
      unit_state: result.unit.state,
      ...(effect === undefined ? {} : { effect: { kind: effect.kind, state: effect.state, operation_id: effect.operation_id } }),
      ...(approval
        ? {
            approval_evidence: {
              diff_hash: diffHash,
              ...(verification === undefined ? {} : { verification }),
              status: reviewStatus,
              ...(approvalWarning === undefined ? {} : { warning: approvalWarning }),
            },
          }
        : {}),
      ...(consolidation === undefined
        ? {}
        : {
            consolidation: {
              status: consolidation.status,
              cell_id: consolidation.cellID,
              ...(consolidation.prompt === undefined ? {} : { prompt: consolidation.prompt }),
            },
          }),
      ...(consolidationError === undefined ? {} : { consolidation_error: consolidationError }),
      ...(unverifiable ? { status: "unverifiable", warning: approvalWarning } : {}),
    },
    content: approval
      ? result.unit.state === "DONE"
        ? `Cell ${taskID} approved and finalized.${unverifiable ? " Warning: verification receipt unavailable; marked unverifiable." : ""}`
        : `Cell ${taskID} approved; completion effect is ${effect?.state ?? "pending"}.`
      : `Review feedback recorded for ${taskID}.`,
  };
}

async function cleanupMissionWorktrees(
  runtime: SwarmxRuntime,
  projectRoot: string | undefined,
  cellIDs: Iterable<string>,
  sessionID: string,
): Promise<Array<{ readonly type: "warning"; readonly code: "worktree_cleanup_failed" | "worktree_cleanup_skipped"; readonly taskID: string; readonly message: string }>> {
  const warnings: Array<{ readonly type: "warning"; readonly code: "worktree_cleanup_failed" | "worktree_cleanup_skipped"; readonly taskID: string; readonly message: string }> = [];
  for (const cellID of cellIDs) {
    if (projectRoot === undefined) {
      warnings.push({ type: "warning", code: "worktree_cleanup_skipped", taskID: cellID, message: "canonical project root is not wired" });
      continue;
    }
    try {
      const result = parseBackendObject(
        await runToolForSession(runtime, "swarm_worktree_cleanup", { project_path: projectRoot, task_id: cellID }, sessionID, 120_000),
      );
      const nestedOutput = parseBackendObject(result.output);
      const failure = [result, nestedOutput].find(
        (candidate) =>
          candidate.success === false || candidate.ok === false || candidate.isError === true || typeof candidate.error === "string",
      );
      if (failure !== undefined) {
        throw new Error(typeof failure.error === "string" ? failure.error : "backend reported cleanup failure");
      }
    } catch (error) {
      warnings.push({
        type: "warning",
        code: "worktree_cleanup_failed",
        taskID: cellID,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return warnings;
}

async function runNativeFinish(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
  reason: string,
  abandon: boolean,
): Promise<ToolExecuteResult> {
  const tool = "swarm_finish";
  const targetSessionID = optionalStringInput(tool, input, "session_id");
  const sessionID = resolveSessionID(runtime, context);
  if (input.all_sessions === true || (targetSessionID !== undefined && targetSessionID !== sessionID)) {
    throw new LocalToolError(tool, "conflict", "native missions can only be closed by their owner session");
  }
  const scope = await requireWorkUnitMissionScope(tool, runtime, context);
  const lockKey = [scope.projectID, scope.sessionID].map(encodeURIComponent).join(":");
  return withReviewDecisionLock(lockKey, async () => {
    const units = await listUnits(scope.runtime.db, scope.mission.id);
    if (!abandon) {
      if (units.some((unit) => NATIVE_PENDING_COMPLETION_STATES.has(unit.state))) {
        throw new LocalToolError(tool, "conflict", "the mission has pending completion reviews");
      }
      if (units.some((unit) => !NATIVE_TERMINAL_STATES.has(unit.state))) {
        throw new LocalToolError(tool, "conflict", "mission has unrevoked worker attempts");
      }
      if (scope.mission.state === "OPEN") {
        await assertConsolidationComplete(
          runtime,
          scope.sessionID,
          parseNativeConsolidation(scope.mission.consolidation_json),
          units.map((unit) => (unit.evidence_json === null ? undefined : nativeEvidence(unit)?.epicID)),
        );
      }
    }
    const actor = { kind: "coordinator" as const, sessionId: scope.sessionID };
    let mission: Mission;
    try {
      mission = abandon
        ? await scope.runtime.commands.cancel(actor, { missionPk: scope.mission.id })
        : await scope.runtime.commands.finish(actor, { missionPk: scope.mission.id });
    } catch (error) {
      if (error instanceof MissionNotDrainedError) {
        throw new LocalToolError(tool, "conflict", "mission has unrevoked worker attempts");
      }
      throw nativeConflict(tool, error);
    }
    const cellIDs = new Set(units.flatMap((unit) => (unit.cell_id === null ? [] : [unit.cell_id])));
    const warnings = await cleanupMissionWorktrees(
      runtime,
      await resolveProjectRoot(tool, runtime),
      cellIDs,
      scope.sessionID,
    );
    return {
      output: {
        sessionID: scope.sessionID,
        finished: true,
        active: mission.state === "OPEN" || mission.state === "CLOSING",
        state: mission.state,
        mode: mission.mode,
        reason,
        ...(warnings.length === 0 ? {} : { warnings }),
      },
      content: `Mission ${scope.sessionID} ${mission.state.toLowerCase()} (mode=${String(mission.mode)}).`,
    };
  });
}

async function resolveCallerMode(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  tool: string,
): Promise<RosterAgent["mode"]> {
  if (runtime.listAgents === undefined || context.agent === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify the calling agent");
  }

  let caller: RosterAgent | undefined;
  try {
    caller = normalizeAgentList(await runtime.listAgents()).find((agent) => agent.id === context.agent);
  } catch {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify the calling agent");
  }
  if (caller === undefined) {
    throw new LocalToolError(
      tool,
      "agent_unknown",
      "the calling agent is not present in the V2 roster",
    );
  }
  return caller.mode;
}

interface AssignedWorkerScope {
  readonly marker: CellMarker;
  readonly agent: RosterAgent;
  readonly parentMission: MissionState;
  readonly attemptCallID: string;
}

async function requireAssignedWorkerScope(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  tool: string,
): Promise<AssignedWorkerScope> {
  if (
    context.sessionID === undefined ||
    context.agent === undefined ||
    runtime.resolveWorkerCell === undefined ||
    runtime.resolveWorkerParentSession === undefined
  ) {
    throw new LocalToolError(tool, "runtime_unavailable", "the worker's assigned cell is not available");
  }

  let marker: CellMarker | undefined;
  let parentSessionID: string | null | undefined;
  try {
    [marker, parentSessionID] = await Promise.all([
      runtime.resolveWorkerCell(context.sessionID),
      runtime.resolveWorkerParentSession(context.sessionID),
    ]);
  } catch {
    throw new LocalToolError(tool, "runtime_unavailable", "the worker session context could not be read");
  }
  if (marker === undefined) {
    throw new LocalToolError(
      tool,
      "conflict",
      "the worker prompt must contain exactly one swarmx cell marker",
    );
  }
  if (marker.dispatchToken === undefined) {
    throw new LocalToolError(tool, "conflict", "the worker prompt has no one-use dispatch capability");
  }
  if (parentSessionID === undefined || parentSessionID === null) {
    throw new LocalToolError(tool, "conflict", "the worker session is not bound to this dispatched worker session");
  }

  // The WorkUnit's bound worker_agent is authoritative and is checked by
  // resolveParentMissionForWorker against this caller.
  requireWorkUnitRuntime(tool, runtime);
  const assignment: string | undefined = context.agent;
  if (assignment === undefined) {
    throw new LocalToolError(tool, "conflict", "the dispatched cell has no persisted agent assignment");
  }
  const agent = (await loadRosterEntries(tool, runtime, context)).find(
    (candidate) => candidate.id === assignment || candidate.name === assignment,
  );
  if (agent === undefined || agent.id !== context.agent) {
    throw new LocalToolError(tool, "conflict", "the caller is not the agent assigned to this cell");
  }
  const scope = { marker, agent };
  const dispatch = await resolveParentMissionForWorker(
    runtime,
    scope,
    parentSessionID,
    context.sessionID,
    tool,
  );
  return { ...scope, ...dispatch };
}

async function resolveParentMissionForWorker(
  runtime: SwarmxRuntime,
  worker: Pick<AssignedWorkerScope, "marker" | "agent">,
  parentSessionID: string,
  workerSessionID: string,
  tool: string,
): Promise<{ readonly parentMission: MissionState; readonly attemptCallID: string }> {
  const workUnit = requireWorkUnitRuntime(tool, runtime);
  const projectID = resolveProjectID(runtime);
  if (projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "project id is not wired");
  }
  const parentMission = await workUnit.store.load(projectID, parentSessionID);
  if (parentMission === undefined || !parentMission.active || parentMission.missionID === undefined) {
    throw new LocalToolError(tool, "conflict", "the worker session's parent has no active swarmx mission");
  }
  const nativeMission = await getMission(workUnit.db, projectID, parentSessionID);
  if (nativeMission === null || nativeMission.mission_id !== parentMission.missionID) {
    throw new LocalToolError(tool, "conflict", "the worker session's parent has no active swarmx mission");
  }
  const unit = (await listUnits(workUnit.db, nativeMission.id)).find((candidate) =>
    candidate.dispatch_token === worker.marker.dispatchToken &&
    candidate.cell_id === worker.marker.cellID &&
    candidate.worker_agent === worker.agent.id,
  );
  if (unit === undefined) {
    throw new LocalToolError(tool, "conflict", "the worker prompt is not bound to a dispatched cell in its parent mission");
  }
  if (unit.state === "BOUND" || unit.state === "SUBMITTED") {
    if (unit.worker_session !== workerSessionID) {
      throw new LocalToolError(tool, "conflict", "the dispatch capability is already bound to another worker session");
    }
  } else if (unit.state === "RESERVED") {
    try {
      await workUnit.commands.bindWorker(
        { kind: "coordinator", sessionId: parentSessionID },
        { unitId: unit.id, unitFence: unit.fence, workerSessionId: workerSessionID, workerAgent: worker.agent.id },
      );
    } catch {
      throw new LocalToolError(tool, "conflict", "the dispatch capability is no longer active");
    }
  } else {
    throw new LocalToolError(tool, "conflict", "the dispatch capability is no longer active");
  }
  return { parentMission, attemptCallID: unit.call_id };
}

function requireAssignedAgentName(tool: string, value: unknown, agent: RosterAgent): void {
  if (value !== agent.id && value !== agent.name) {
    throw new LocalToolError(tool, "conflict", "agent_name does not match the caller assigned to this cell");
  }
}

async function requireHiveCloseAllowed(
  runtime: SwarmxRuntime,
  input: Record<string, unknown>,
): Promise<void> {
  const cellID = typeof input.id === "string" ? input.id : "";
  const projectID = resolveProjectID(runtime);
  const workUnit = requireWorkUnitRuntime("hive_close", runtime);
  if (projectID === undefined || cellID.length === 0) {
    throw new LocalToolError("hive_close", "runtime_unavailable", "cannot verify active project missions");
  }
  return requireNativeHiveCloseAllowed(workUnit, projectID, cellID);
}

async function nativeProjectScan(
  tool: string,
  native: NonNullable<SwarmxRuntime["workUnit"]>,
  projectID: string,
  message = "cannot verify active project missions",
) {
  try {
    return await listProjectNative(native.db, projectID);
  } catch {
    throw new LocalToolError(tool, "runtime_unavailable", message);
  }
}

async function requireNativeHiveCloseAllowed(
  native: NonNullable<SwarmxRuntime["workUnit"]>,
  projectID: string,
  cellID: string,
): Promise<void> {
  const generations = await nativeProjectScan("hive_close", native, projectID);
  const active = generations.filter((entry) => isLiveMission(entry.mission));
  for (const { units } of active) {
    const cellUnits = units.filter((unit) => unit.cell_id === cellID);
    if (cellUnits.length === 0) continue;
    // Approved-completion exception judged on the LATEST unit only: an older DONE
    // must not authorize closing over newer live work (DONE leaves the live index).
    const latest = cellUnits.reduce((left, right) =>
      right.created_at > left.created_at || (right.created_at === left.created_at && right.attempt_no >= left.attempt_no)
        ? right
        : left);
    if (APPROVED_UNIT_STATES.has(latest.state)) return;
    throw new LocalToolError(
      "hive_close",
      "conflict",
      "active swarmx cells close only through an approved swarm_complete call or an approved review receipt",
    );
  }
  if (active.length > 0) {
    throw new LocalToolError("hive_close", "conflict", "active swarmx cells close only through an approved swarm_complete call");
  }
  if (generations.some(({ units }) => units.some((unit) => unit.cell_id === cellID && LIVE_UNIT_STATES.has(unit.state)))) {
    throw new LocalToolError("hive_close", "conflict", "the cell still has an unrevoked worker attempt");
  }
}

async function restrictHiveUpdate(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<void> {
  if (
    context.agent === "swarm/swarm-coordinator" &&
    (await resolveCallerMode(runtime, context, "hive_update")) === "primary"
  ) {
    if (input.status === "closed") {
      await requireNoActiveProjectMission(runtime, "hive_update");
    }
    return;
  }
  const scope = await requireAssignedWorkerScope(runtime, context, "hive_update");
  if (input.id !== scope.marker.cellID) {
    throw new LocalToolError("hive_update", "conflict", "a subagent may update only its assigned cell");
  }
  const allowedStatus = input.status === "in_progress" || input.status === "blocked";
  const planningChange = input.description !== undefined || input.priority !== undefined;
  if (!allowedStatus || planningChange) {
    throw new LocalToolError(
      "hive_update",
      "conflict",
      "subagents may only set their assigned cell to in_progress or blocked",
    );
  }
}

async function requireNoActiveProjectMission(runtime: SwarmxRuntime, tool: string): Promise<void> {
  const projectID = resolveProjectID(runtime);
  if (runtime.workUnit === undefined || projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify active project missions");
  }
  const generations = await nativeProjectScan(tool, runtime.workUnit, projectID);
  if (generations.some((entry) => isLiveMission(entry.mission))) {
    throw new LocalToolError(tool, "conflict", "active swarmx cells close only through an approved swarm_complete call");
  }
  if (generations.some(({ units }) => units.some((unit) => LIVE_UNIT_STATES.has(unit.state)))) {
    throw new LocalToolError(tool, "conflict", "the project still has unrevoked worker attempts");
  }
}

async function requireNoActiveTaskAttempt(
  runtime: SwarmxRuntime,
  tool: string,
  taskID: string,
): Promise<void> {
  const projectID = resolveProjectID(runtime);
  if (runtime.workUnit === undefined || projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify active task attempts");
  }
  const generations = await nativeProjectScan(tool, runtime.workUnit, projectID, "cannot verify active task attempts");
  if (generations.some(({ units }) => units.some((unit) => unit.cell_id === taskID && LIVE_UNIT_STATES.has(unit.state)))) {
    throw new LocalToolError(tool, "conflict", `task ${taskID} has an unrevoked worker attempt`);
  }
}

async function runWorktreeCleanup(
  runtime: SwarmxRuntime,
  args: Record<string, unknown>,
  sessionID: string,
  backendName: string,
): Promise<ToolExecuteResult> {
  const projectID = resolveProjectID(runtime);
  const native = runtime.workUnit;
  if (native === undefined || projectID === undefined) {
    throw new LocalToolError(
      "swarm_worktree_cleanup",
      "runtime_unavailable",
      "mission storage is not wired",
    );
  }
  const normalized: Record<string, unknown> = {
    ...args,
    project_path: await validateProjectRoot(runtime, "swarm_worktree_cleanup", args.project_path),
  };
  const claimTaskID =
    normalized.cleanup_all === true
      ? "*"
      : requireStringInput("swarm_worktree_cleanup", normalized, "task_id");
  // The SQL cleanup lock (held until `finally`) blocks every project dispatch.
  const lockToken = randomUUID();
  const acquired = await acquireWorkUnitLock(native.db, {
    name: cleanupLockName(projectID),
    token: lockToken,
    ownerSession: sessionID,
    now: Date.now(),
    staleAfterMs: CLEANUP_LOCK_STALE_MS,
  });
  if (!acquired.acquired) {
    throw new LocalToolError("swarm_worktree_cleanup", "conflict", "another worktree cleanup is already in progress");
  }
  try {
    if (normalized.cleanup_all === true) {
      await requireNoActiveProjectMission(runtime, "swarm_worktree_cleanup");
    } else {
      await requireNoActiveTaskAttempt(runtime, "swarm_worktree_cleanup", claimTaskID);
    }
    return { output: await runToolForSession(runtime, backendName, normalized, sessionID, 120_000) };
  } finally {
    await releaseWorkUnitLock(native.db, {
      name: cleanupLockName(projectID),
      token: lockToken,
      fence: acquired.fence,
    }).catch(() => false);
  }
}

async function restrictWorkerProgress(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const scope = await requireAssignedWorkerScope(runtime, context, "swarm_progress");
  if (input.bead_id !== scope.marker.cellID) {
    throw new LocalToolError("swarm_progress", "conflict", "progress may report only the assigned cell");
  }
  requireAssignedAgentName("swarm_progress", input.agent_name, scope.agent);
  if (input.status !== "in_progress" && input.status !== "blocked") {
    throw new LocalToolError(
      "swarm_progress",
      "conflict",
      "subagents must complete through swarm_complete rather than setting a terminal progress status",
    );
  }
  const projectPath = await validateProjectRoot(runtime, "swarm_progress", input.project_key);
  const args = { ...input, project_key: projectPath };
  if (input.files_touched !== undefined) {
    return validateProjectFiles(runtime, "swarm_progress", args, projectPath);
  }
  return args;
}

function rejectCompletionOverrides(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): void {
  // Anything but an omitted flag or an explicit `false` is refused, so string
  // or numeric truthiness can never smuggle a bypass down to the backend.
  for (const flag of ["skip_review", "skip_verification"] as const) {
    if (input[flag] !== undefined && input[flag] !== false) {
      emitViolation(runtime.sessionEvents, {
        sessionID: resolveSessionID(runtime, context),
        violationType: "skip_bypass_attempt",
        payload: {
          tool: "swarm_complete",
          flag,
          bead_id: typeof input.bead_id === "string" ? input.bead_id : null,
        },
      });
      throw new LocalToolError(
        "swarm_complete",
        "conflict",
        `swarmx never allows review or verification bypasses (${flag} must be omitted)`,
      );
    }
  }
}

const COORDINATOR_ONLY_TOOL_NAMES = new Set([
  "hive_close",
  "hive_create",
  "hive_create_epic",
  "hive_start",
  "hive_sync",
  "swarm_worktree_cleanup",
  "swarm_finish",
  "swarm_mission_status",
  "swarm_cancel_completion",
  "swarmmail_release_agent",
  "swarmmail_release_all",
  "swarm_resolve_agent",
  "swarm_review",
  "swarm_review_feedback",
  "swarm_set_agent",
  "swarm_set_budget",
]);
const SUBAGENT_FORBIDDEN_TOOL_NAMES = new Set([
  "hivemind_remove",
  "skills_add_script",
  "skills_create",
  "skills_delete",
  "skills_execute",
  "skills_init",
  "skills_update",
  "swarm_worktree_merge",
]);

async function requireCoordinator(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  tool: string,
): Promise<void> {
  const coordinatorAgents = new Set(["build", "plan", "swarm/swarm-coordinator"]);
  if (
    !coordinatorAgents.has(context.agent ?? "") ||
    (await resolveCallerMode(runtime, context, tool)) !== "primary"
  ) {
    throw new LocalToolError(tool, "conflict", "only the canonical swarm coordinator may use this tool");
  }
}

/**
 * `swarm_finish` releases the caller's own mission.
 *
 * Requiring the coordinator agent here deadlocks any other primary session that
 * has an active mission: `gateBefore` refuses its dispatches (not the
 * coordinator) and `swarm_finish` refuses the release, with no third exit. The
 * mission owner is therefore accepted as well; a coordinator session still
 * passes the stricter check first.
 */
async function requireCoordinatorOrMissionOwner(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  tool: string,
): Promise<void> {
  try {
    await requireCoordinator(runtime, context, tool);
    return;
  } catch (error) {
    if (!(error instanceof LocalToolError) || error.code !== "conflict") throw error;
  }

  const projectID = resolveProjectID(runtime);
  const sessionID = resolveSessionID(runtime, context);
  if (runtime.workUnit === undefined || projectID === undefined || sessionID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify the mission owner");
  }
  const mission = await getMission(runtime.workUnit.db, projectID, sessionID);
  const ownsActiveMission = mission !== null && isLiveMission(mission);
  if (!ownsActiveMission || (await resolveCallerMode(runtime, context, tool)) !== "primary") {
    throw new LocalToolError(tool, "conflict", "only the canonical swarm coordinator may use this tool");
  }
}

function matchesAgentIdentity(requested: unknown, expected: string): boolean {
  if (typeof requested !== "string") return false;
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return normalize(requested) === normalize(expected);
}

async function bindSwarmMailIdentity(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projectPath = await validateProjectRoot(runtime, "swarmmail_init", input.project_path);
  const callerID = context.agent;
  if (callerID === undefined) {
    throw new LocalToolError("swarmmail_init", "runtime_unavailable", "the V2 caller identity is unavailable");
  }
  const caller = (await loadRosterEntries("swarmmail_init", runtime, context)).find(
    (agent) => agent.id === callerID,
  );
  if (caller === undefined) {
    throw new LocalToolError("swarmmail_init", "agent_unknown", "the V2 caller is not present in the agent roster");
  }
  const requestedName = input.agent_name;
  if (
    requestedName !== undefined &&
    !matchesAgentIdentity(requestedName, caller.id) &&
    !matchesAgentIdentity(requestedName, caller.name)
  ) {
    throw new LocalToolError(
      "swarmmail_init",
      "conflict",
      `agent_name must match the V2 caller (${caller.name})`,
    );
  }
  if ((await resolveCallerMode(runtime, context, "swarmmail_init")) !== "primary") {
    await requireAssignedWorkerScope(runtime, context, "swarmmail_init");
  }
  return { ...input, project_path: projectPath, agent_name: caller.name };
}

async function restrictSwarmMailRelease(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<void> {
  const isCoordinator =
    context.agent === "swarm/swarm-coordinator" &&
    (await resolveCallerMode(runtime, context, "swarmmail_release")) === "primary";
  if (input.reservation_ids !== undefined && !isCoordinator) {
    throw new LocalToolError(
      "swarmmail_release",
      "conflict",
      "subagents may release reservation paths, not reservation IDs",
    );
  }
  if (!isCoordinator && (await resolveCallerMode(runtime, context, "swarmmail_release")) !== "primary") {
    await requireAssignedWorkerScope(runtime, context, "swarmmail_release");
  }
}

async function executeSpec(
  spec: ToolSpec,
  runtime: SwarmxRuntime,
  input: unknown,
  context: ToolExecuteContextLike,
  assertPermission: (input: ToolPermissionAssertion) => Promise<void>,
): Promise<ToolExecuteResult> {
  if (spec.status === "deprecated") {
    throw new UnsupportedToolError(spec.name, spec.deprecatedReason ?? "aucun remplacement documenté");
  }

  const sessionID = resolveSessionID(runtime, context);
  if (
    sessionID === undefined ||
    typeof context.agent !== "string" ||
    context.agent.length === 0 ||
    typeof context.messageID !== "string" ||
    context.messageID.length === 0 ||
    typeof context.id !== "string" ||
    context.id.length === 0
  ) {
    throw new LocalToolError(
      spec.name,
      "runtime_unavailable",
      "V2 tool permission context is incomplete",
    );
  }
  await assertPermission({
    sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
    action: spec.name,
    resources: [spec.name],
    save: [spec.name],
  });

  let args = asArguments(input);
  if (COORDINATOR_ONLY_TOOL_NAMES.has(spec.name)) {
    if (spec.name === "swarm_finish") {
      await requireCoordinatorOrMissionOwner(runtime, context, spec.name);
    } else {
      await requireCoordinator(runtime, context, spec.name);
    }
  }
  if (
    SUBAGENT_FORBIDDEN_TOOL_NAMES.has(spec.name) &&
    (await resolveCallerMode(runtime, context, spec.name)) !== "primary"
  ) {
    throw new LocalToolError(
      spec.name,
      "conflict",
      "subagents may not run skill scripts, merge worktrees, mutate shared skills, or delete shared memory",
    );
  }
  if (spec.name === "swarm_complete") {
    requireStringInput("swarm_complete", args, "agent_name");
    const beadID = requireStringInput("swarm_complete", args, "bead_id");
    requireStringInput("swarm_complete", args, "summary");
    if (args.start_time !== undefined) {
      if (
        typeof args.start_time !== "number" ||
        !Number.isSafeInteger(args.start_time) ||
        args.start_time < 0
      ) {
        throw new LocalToolError("swarm_complete", "invalid_input", "start_time must be a non-negative Unix-millisecond timestamp");
      }
    }
    rejectCompletionOverrides(runtime, context, args);
    if (context.agent === "swarm/swarm-coordinator") {
      throw new LocalToolError("swarm_complete", "conflict", "the coordinator closes reviewed cells through hive_close");
    }
    const scope = await requireAssignedWorkerScope(runtime, context, "swarm_complete");
    if (beadID !== scope.marker.cellID) {
      throw new LocalToolError("swarm_complete", "conflict", "bead_id does not match the caller's assigned cell");
    }
    requireAssignedAgentName("swarm_complete", args.agent_name, scope.agent);
    if (args.start_time === undefined) {
      // The submission time is only a fallback: a missing start_time means the
      // worker never recorded when the cell started, so the duration evidence
      // is lost. Record the violation, then keep the lenient fallback.
      emitViolation(runtime.sessionEvents, {
        sessionID: resolveSessionID(runtime, context),
        epicID: scope.marker.epicID,
        violationType: "missing_start_time",
        payload: {
          tool: "swarm_complete",
          bead_id: beadID,
          agent_name: args.agent_name,
        },
      });
    }
    args = await validateProjectFiles(
      runtime,
      "swarm_complete",
      args,
      await validateProjectRoot(runtime, "swarm_complete", args.project_key),
    );
    requireWorkUnitRuntime("swarm_complete", runtime);
    return submitNativeCompletion(runtime, context, args, scope);
  }
  if (spec.name === "swarmmail_init") {
    args = await bindSwarmMailIdentity(runtime, context, args);
  }
  if (spec.name === "swarmmail_release") {
    await restrictSwarmMailRelease(runtime, context, args);
  }
  if (spec.name === "hive_close") {
    await requireHiveCloseAllowed(runtime, args);
  }
  if (spec.name === "hive_update") {
    await restrictHiveUpdate(runtime, context, args);
  }
  if (spec.name === "swarm_progress") {
    args = await restrictWorkerProgress(runtime, context, args);
  }
  if (spec.name === "swarm_review") {
    args = await validateReviewScope(runtime, args);
    await requireOpenNativeMission(runtime, context, "swarm_review");
  }
  if (spec.name === "swarm_review_feedback") {
    return executeReviewFeedback(runtime, context, args);
  }
  if (spec.name === "swarm_worktree_cleanup") {
    const backendName = spec.backendName;
    if (backendName === undefined) {
      throw new UnsupportedToolError(spec.name, "backendName manquant dans le catalogue");
    }
    return runWorktreeCleanup(runtime, args, sessionID, backendName);
  }
  if (spec.name === "swarm_spawn_retry") {
    const backendName = spec.backendName;
    if (backendName === undefined) {
      throw new UnsupportedToolError(spec.name, "backendName manquant dans le catalogue");
    }
    return runSpawnRetry(runtime, context, args, backendName, sessionID);
  }
  if (DECOMPOSITION_HISTORY_TOOL_NAMES.has(spec.name)) {
    const backendName = spec.backendName;
    if (backendName === undefined) {
      throw new UnsupportedToolError(spec.name, "backendName manquant dans le catalogue");
    }
    return runDecomposition(runtime, spec.name, args, backendName, sessionID);
  }
  if (spec.kind === "backend") {
    const backendName = spec.backendName;
    if (backendName === undefined) {
      throw new UnsupportedToolError(spec.name, "backendName manquant dans le catalogue");
    }
    const isReview = spec.name === "swarm_review";
    // Resolve the actual git toplevel instead of trusting runtime.projectPath,
    // which may point at a subdirectory or a non-git path.
    let projectRoot: string | undefined;
    if (isReview && typeof runtime.projectPath === "string") {
      const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: runtime.projectPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      projectRoot = toplevel.status === 0 && typeof toplevel.stdout === "string"
        ? toplevel.stdout.trim()
        : runtime.projectPath;
    }
    const files = isReview && Array.isArray(args.files_touched) ? (args.files_touched as string[]) : [];
    // No git add here: workers may run in a sandbox where git write is blocked.
    // Untracked files are accepted in checkScopedReviewDiff when they exist on disk.
    const slowBackend = isReview || spec.name === "swarm_complete";
    let output: unknown;
    try {
      if (isReview && files.length === 0) {
        // No-file tasks (research, analysis) have no diff to review. Skip the
        // backend entirely and create a synthetic empty review so the plugin
        // can still record the native review and finalize the cell.
        output = {
          review_prompt: "## Files Modified\n\n## Code Changes\n```diff\n\n```\n\n## Review Criteria",
          context: { files_touched: [] },
        };
      } else {
        output = await runToolForSession(
          runtime,
          backendName,
          args,
          sessionID,
          slowBackend ? 120_000 : undefined,
        );
      }
      if (isReview) {
        output = enrichReviewOutputWithNewFiles(output, files, runtime.projectPath ?? projectRoot);
        await recordNativeScopedReview(runtime, context, args, output);
      }
    } finally {
      // No-op: no git staging was performed, so nothing to reset.
    }
    return { output };
  }

  return executeLocal(spec, runtime, args, context);
}

/**
 * Permissive output schema declared by every swarmx tool.
 *
 * V2 refuses any handler result that carries an `output` field when the tool
 * declared no output schema: `Tool result declared output without an output
 * schema`. Every swarmx handler returns `{ output }` — a CLI string, a local
 * object, or `undefined` for void operations — so a single permissive standard
 * schema is declared once here instead of 82 near-identical JSON Schemas.
 *
 * A Standard Schema is used rather than an empty JSON Schema because the host
 * validates against `fi` (JSON values only) for plain schemas, which would
 * reject `undefined` outputs, while `validate` accepts any value.
 */
const SWARMX_OUTPUT_SCHEMA = {
  "~standard": {
    version: 1,
    vendor: "swarmx",
    validate: (value: unknown) => ({ value }),
    jsonSchema: { output: () => ({}) },
  },
} as const;

/**
 * Registers all 82 tools through one synchronous, replayable transform.
 *
 * The callback performs no I/O and rebuilds the same definitions on every
 * replay, so registering twice is idempotent.
 *
 * @param ctx - context exposing `tool.transform` (production: `Plugin.Context`).
 * @param runtime - backend execution boundary (production: CLI runner).
 */
export async function registerTools(ctx: ToolContextLike, runtime: SwarmxRuntime): Promise<void> {
  await ctx.tool.transform((editor) => {
    for (const spec of SWARMX_TOOL_SPECS) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: spec.inputSchema,
        output: SWARMX_OUTPUT_SCHEMA,
        execute: (input, context) =>
          executeSpec(
            spec,
            runtime,
            input,
            asExecuteContext(context),
            (permission) => ctx.permission.assert(permission),
          ),
      });
    }
  });
}
