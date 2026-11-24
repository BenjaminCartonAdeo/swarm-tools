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
import { createHash } from "node:crypto";
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
  audit,
  completeConsolidation,
  getAttempt,
  finishMission,
  isConsolidationCellFinished,
  listAssignments,
  listAttempts,
  maybePrepareConsolidation,
  readMission,
  resolveAssignment,
  sameMissionGeneration,
  selectCells,
  selectMissionSummary,
  selectReadyCells,
  setAssignment,
  setBudget,
  putAttempt,
  recordRetryCause,
  resetMission,
  withMissionLock,
} from "./state";
import type { MissionStateStore } from "./state";
import { emitDecision, emitViolation } from "./session-events";
import {
  LocalToolError,
  UnsupportedToolError,
  type CellMarker,
  type ConsolidationState,
  type DispatchAgentInfo,
  type DispatchAgentList,
  type DispatchAttempt,
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
    "Coordinator-only: finish the current swarmx mission, deactivate dispatch gates, and report the closing reason. Set abandon=true to revoke all pending/succeeded attempts and force-close.",
    { reason: str("Why the mission ends"), abandon: bool("Revoke all pending/succeeded attempts and force-close the mission") },
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
    "Check repository prerequisites before running swarm work: dependencies, test runner, Git remote, and GitHub CLI.",
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

interface StoreScope {
  readonly store: MissionStateStore;
  readonly projectID: string;
}

interface MissionScope extends StoreScope {
  readonly sessionID: string;
  /** Canonical (`realpath`) active project root, when the host wires one. */
  readonly projectRoot?: string;
}

function requireStoreProject(tool: string, runtime: SwarmxRuntime): StoreScope {
  const store = runtime.store;
  if (store === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "mission store is not wired");
  }
  const projectID = resolveProjectID(runtime);
  if (projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "project id is not wired");
  }
  return { store, projectID };
}

async function requireMissionScope(
  tool: string,
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<MissionScope> {
  const scope = requireStoreProject(tool, runtime);
  const sessionID = resolveSessionID(runtime, context);
  if (sessionID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "no session id in the tool context");
  }
  const projectRoot = await resolveProjectRoot(tool, runtime);
  return projectRoot === undefined
    ? { ...scope, sessionID }
    : { ...scope, sessionID, projectRoot };
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
    const { store, projectID } = requireStoreProject("swarm_resolve_agent", runtime);
    const sessionID = resolveSessionID(runtime, context);
    const owner = sessionID === undefined ? undefined : { sessionID };
    for (const result of results) {
      if (result.agent === null) continue;
      if (result.bead_id === undefined) {
        throw new LocalToolError(
          "swarm_resolve_agent",
          "invalid_input",
          `cannot persist the assignment of "${result.title}": bead_id is required when apply=true`,
        );
      }
      await setAssignment(store, projectID, result.bead_id, result.agent, owner);
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
  const { store, projectID } = requireStoreProject("swarm_set_agent", runtime);
  const sessionID = resolveSessionID(runtime, context);
  await setAssignment(
    store,
    projectID,
    beadID,
    entry.id,
    sessionID === undefined ? undefined : { sessionID },
  );
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
  if (runtime.store !== undefined && projectID !== undefined) {
    await recordRetryCause(runtime.store, {
      projectID,
      sessionID,
      cellID,
      epicID,
      attempt,
      cause,
    });
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
  const { store, projectID, sessionID } = await requireMissionScope("swarm_set_budget", runtime, context);
  try {
    const state = await setBudget(store, { projectID, sessionID, mode, maxSpawns, maxIterations });
    return {
      output: { sessionID, mode: state.mode, active: state.active, budget: state.budget },
      content:
        `Budget fixed: mode=${state.mode} max_spawns=${state.budget.maxSpawns} ` +
        `max_iterations=${state.budget.maxIterations}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes("already set") ? "conflict" : "invalid_input";
    throw new LocalToolError("swarm_set_budget", code, message);
  }
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
  mission: MissionState,
  attempts: readonly DispatchAttempt[],
): Promise<void> {
  const epicIDs = new Set<string>();
  if (mission.consolidation !== undefined) epicIDs.add(mission.consolidation.epicID);
  for (const attempt of attempts) {
    if (attempt.epicID !== undefined && attempt.epicID.length > 0) epicIDs.add(attempt.epicID);
  }
  for (const epicID of epicIDs) {
    const consolidation = mission.consolidation?.epicID === epicID ? mission.consolidation : undefined;
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

async function runFinish(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const reason = optionalStringInput("swarm_finish", input, "reason") ?? "";
  const abandon = input.abandon === true;
  const { store, projectID, sessionID, projectRoot } = await requireMissionScope("swarm_finish", runtime, context);
  const lockKey = [projectID, sessionID].map(encodeURIComponent).join(":");
  return withReviewDecisionLock(lockKey, async () => {
    const current = await readMission(store, projectID, sessionID);
    if (current === undefined) {
      throw new LocalToolError(
        "swarm_finish",
        "not_found",
        `no mission for session ${sessionID}; call swarm_set_budget first`,
      );
    }
    const attempts = await listAttempts(store, projectID, sessionID, current);
    if (!abandon) {
      // Only block on attempts that have a pending (unfinalized) completion.
      // Succeeded/failed attempts without a pending completion do not block.
      const pendingCellIDs = new Set(attempts.map((a) => a.cellID));
      let hasPendingCompletion = false;
      for (const cellID of pendingCellIDs) {
        const pending = await readPendingCompletion(store, projectID, cellID);
        if (pending !== undefined && pending.parentSessionID === sessionID && pending.missionID === reviewMissionID(current) && pending.finalized !== true) {
          hasPendingCompletion = true;
          break;
        }
      }
      if (hasPendingCompletion) {
        throw new LocalToolError("swarm_finish", "conflict", "the mission has pending completion reviews");
      }
    }
    const missionID = reviewMissionID(current);
    if (abandon) {
      // Force-close: cancel every pending completion and skip consolidation.
      for (const cellID of new Set(attempts.map((attempt) => attempt.cellID))) {
        const pending = await readPendingCompletion(store, projectID, cellID);
        if (
          pending !== undefined &&
          pending.parentSessionID === sessionID &&
          pending.missionID === missionID &&
          pending.finalized !== true
        ) {
          await store.storage.set(pendingCompletionKey(projectID, cellID), {
            ...pending,
            canceled: true,
            cancelReason: reason || "mission abandoned",
            canceledAt: store.now(),
            finalized: true,
            finalizing: false,
          });
        }
      }
    } else {
      for (const cellID of new Set(attempts.map((attempt) => attempt.cellID))) {
        const pending = await readPendingCompletion(store, projectID, cellID);
        const review = await store.storage.get(reviewReceiptKey(projectID, sessionID, missionID, cellID));
        const pendingForMission =
          pending !== undefined &&
          pending.parentSessionID === sessionID &&
          pending.missionID === missionID;
        if (review !== undefined && !(pendingForMission && pending.finalized === true)) {
          throw new LocalToolError("swarm_finish", "conflict", "the mission has pending completion reviews");
        }
        if (pendingForMission && pending.finalized !== true) {
          throw new LocalToolError("swarm_finish", "conflict", "the mission has pending completion reviews");
        }
      }
    }
    if (current.active && !abandon) {
      await assertConsolidationComplete(runtime, sessionID, current, attempts);
    }
    let mission: MissionState | undefined;
    try {
      mission = await finishMission(store, { projectID, sessionID, abandon });
    } catch (error) {
      if (error instanceof Error && error.message === "mission has unrevoked worker attempts") {
        throw new LocalToolError("swarm_finish", "conflict", error.message);
      }
      throw error;
    }
    if (mission === undefined) {
      throw new LocalToolError(
        "swarm_finish",
        "not_found",
        `no mission for session ${sessionID}; call swarm_set_budget first`,
      );
    }
    const cleanupWarnings: Array<{
      readonly type: "warning";
      readonly code: "worktree_cleanup_failed" | "worktree_cleanup_skipped";
      readonly taskID: string;
      readonly message: string;
    }> = [];
    const cellIDs = new Set(attempts.map((attempt) => attempt.cellID));
    if (projectRoot === undefined) {
      for (const cellID of cellIDs) {
        cleanupWarnings.push({
          type: "warning",
          code: "worktree_cleanup_skipped",
          taskID: cellID,
          message: "canonical project root is not wired",
        });
      }
    } else {
      for (const cellID of cellIDs) {
        try {
          const result = parseBackendObject(
            await runToolForSession(
              runtime,
              "swarm_worktree_cleanup",
              { project_path: projectRoot, task_id: cellID },
              sessionID,
              120_000,
            ),
          );
          const nestedOutput = parseBackendObject(result.output);
          const failure = [result, nestedOutput].find(
            (candidate) =>
              candidate.success === false ||
              candidate.ok === false ||
              candidate.isError === true ||
              typeof candidate.error === "string",
          );
          if (failure !== undefined) {
            throw new Error(
              typeof failure.error === "string" ? failure.error : "backend reported cleanup failure",
            );
          }
        } catch (error) {
          cleanupWarnings.push({
            type: "warning",
            code: "worktree_cleanup_failed",
            taskID: cellID,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return {
      output: {
        sessionID,
        finished: true,
        active: mission.active,
        mode: mission.mode,
        counts: mission.counts,
        reason,
        ...(cleanupWarnings.length === 0 ? {} : { warnings: cleanupWarnings }),
      },
      content: `Mission ${sessionID} finished (mode=${mission.mode}, spawns=${mission.counts.spawns}).`,
    };
  });
}

async function runCancelCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const { store, projectID, sessionID } = await requireMissionScope("swarm_cancel_completion", runtime, context);
  const beadID = requireStringInput("swarm_cancel_completion", input, "bead_id");
  const reason = requireStringInput("swarm_cancel_completion", input, "reason");
  const mission = await readMission(store, projectID, sessionID);
  if (mission === undefined || !mission.active) {
    throw new LocalToolError("swarm_cancel_completion", "not_found", "no active mission");
  }
  const pending = await readPendingCompletion(store, projectID, beadID);
  if (pending === undefined || pending.parentSessionID !== sessionID || pending.missionID !== reviewMissionID(mission)) {
    throw new LocalToolError("swarm_cancel_completion", "not_found", "no pending completion for this cell in the active mission");
  }
  const key = pendingCompletionKey(projectID, beadID);
  await withMissionLock(projectID, sessionID, async () => {
    const current = await readPendingCompletion(store, projectID, beadID);
    if (current === undefined || current.finalized === true) {
      throw new LocalToolError("swarm_cancel_completion", "conflict", "completion is already finalized");
    }
    await store.storage.set(key, {
      ...current,
      canceled: true,
      cancelReason: reason,
      canceledAt: store.now(),
      finalized: true,
      finalizing: false,
    });
    const attempt = await getAttempt(store, projectID, current.attemptCallID);
    if (attempt !== undefined && attempt.revokedAt === undefined) {
      await putAttempt(store, projectID, { ...attempt, revokedAt: store.now() });
    }
  });
  return {
    output: { bead_id: beadID, canceled: true, reason },
    content: `Pending completion for ${beadID} canceled: ${reason}`,
  };
}

async function runAmendCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  input: Record<string, unknown>,
): Promise<ToolExecuteResult> {
  const beadID = requireStringInput("swarm_amend_completion", input, "bead_id");
  const reason = requireStringInput("swarm_amend_completion", input, "reason");
  const scope = await requireAssignedWorkerScope(runtime, context, "swarm_amend_completion");
  const { store, projectID } = requireStoreProject("swarm_amend_completion", runtime);
  const pending = await readPendingCompletion(store, projectID, beadID);
  if (
    pending === undefined ||
    pending.workerSessionID !== context.sessionID ||
    pending.workerAgentID !== scope.agent.id ||
    pending.attemptCallID !== scope.attemptCallID ||
    pending.finalized === true
  ) {
    throw new LocalToolError("swarm_amend_completion", "conflict", "no amendable pending completion for this worker");
  }
  const validated = await validateProjectFiles(
    runtime,
    "swarm_amend_completion",
    { ...input, project_key: pending.projectPath },
    pending.projectPath,
  );
  const requested = validated.files_touched as string[];
  const effective: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  for (const file of requested) {
    const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", file], {
      cwd: pending.projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tracked.exitCode !== 0) {
      excluded.push({ file, reason: "untracked" });
      continue;
    }
    const diff = Bun.spawnSync(["git", "diff", "HEAD", "--", file], {
      cwd: pending.projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (diff.stdout.toString().trim().length === 0) {
      excluded.push({ file, reason: "no diff" });
      continue;
    }
    effective.push(file);
  }
  const key = pendingCompletionKey(projectID, beadID);
  await withMissionLock(projectID, pending.parentSessionID, async () => {
    const current = await readPendingCompletion(store, projectID, beadID);
    if (current === undefined || current.finalized === true) {
      throw new LocalToolError("swarm_amend_completion", "conflict", "completion changed before amendment");
    }
    await store.storage.set(key, {
      ...current,
      filesTouched: effective,
      amendedAt: store.now(),
      amendmentReason: reason,
    });
  });
  return {
    output: { bead_id: beadID, files_touched: effective, excluded, reason },
    content: `Amended ${beadID}: effective files=${effective.length}, excluded=${excluded.length}`,
  };
}

async function runReset(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const { store, projectID, sessionID } = await requireMissionScope("swarm_reset", runtime, context);
  await resetMission(store, { projectID, sessionID });
  return {
    output: { sessionID, reset: true },
    content: `Mission ${sessionID} reset. Call swarm_set_budget to start a new mission.`,
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

async function runPreflight(runtime: SwarmxRuntime): Promise<ToolExecuteResult> {
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
  ];
  const ok = checks.every((check) => check.ok);
  return {
    output: { ok, checks },
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

async function runAgentAudit(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
): Promise<ToolExecuteResult> {
  const { store, projectID, sessionID } = await requireMissionScope("swarm_agent_audit", runtime, context);
  const result: MissionAudit = await audit(store, projectID, sessionID);
  const mission = await readMission(store, projectID, sessionID);
  const assignments = await listAssignments(store, projectID);
  const summary = selectMissionSummary(mission);
  const cells = selectCells({ ...(mission === undefined ? {} : { state: mission }), attempts: result.attempts, assignments });
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
    `attempts: ${result.attempts.length}, pending orphans repaired: ${result.pendingOrphans}`,
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
    case "swarm_cancel_completion":
      return runCancelCompletion(runtime, context, args);
    case "swarm_amend_completion":
      return runAmendCompletion(runtime, context, args);
    case "swarm_reset":
      return runReset(runtime, context);
    case "swarm_repo_inventory":
      return runRepoInventory(runtime, context);
    case "swarm_preflight":
      return runPreflight(runtime);
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
interface ReviewApprovalEvidence {
  readonly diffHash: string;
  readonly verification?: VerificationGateReceipt;
  readonly approvedAt: number;
  readonly status?: "approved" | "unverifiable";
  readonly warning?: string;
}

interface ScopedReviewReceipt {
  readonly projectID: string;
  readonly sessionID: string;
  readonly missionID: string;
  readonly projectPath: string;
  readonly epicID: string;
  readonly taskID: string;
  readonly assignedAgentID: string;
  readonly assignedAgentName: string;
  readonly attemptCallID: string;
  readonly dispatchToken: string;
  readonly filesTouched: readonly string[];
  readonly diffHash: string;
  readonly reviewedAt: number;
  /** Set once the receipt has been approved; a consumed receipt cannot replay. */
  readonly approval?: ReviewApprovalEvidence;
}

const REVIEW_RECEIPT_PREFIX = "review-receipt:";
const PENDING_COMPLETION_PREFIX = "pending-completion:";

interface PendingCompletionReceipt {
  readonly projectID: string;
  readonly parentSessionID: string;
  readonly missionID: string;
  readonly workerSessionID: string;
  readonly taskID: string;
  readonly epicID: string;
  readonly workerAgentID: string;
  readonly workerAgentName: string;
  readonly attemptCallID: string;
  readonly dispatchToken: string;
  readonly projectPath: string;
  readonly summary: string;
  readonly startTime: number;
  readonly filesTouched: readonly string[];
  readonly submittedAt: number;
  readonly finalizing?: boolean;
  readonly finalized?: boolean;
  readonly canceled?: boolean;
  readonly cancelReason?: string;
  readonly canceledAt?: number;
  readonly amendedAt?: number;
  readonly amendmentReason?: string;
  /** Snapshot of the completion gate receipt, kept for recovery after a crash. */
  readonly verification?: VerificationGateReceipt;
}

function reviewMissionID(mission: MissionState): string {
  return mission.missionID ?? `legacy:${mission.createdAt}`;
}

function reviewReceiptKey(projectID: string, sessionID: string, missionID: string, taskID: string): string {
  return [REVIEW_RECEIPT_PREFIX, projectID, sessionID, missionID, taskID]
    .map(encodeURIComponent)
    .join(":");
}

export function pendingCompletionKey(projectID: string, taskID: string): string {
  return [PENDING_COMPLETION_PREFIX, projectID, taskID].map(encodeURIComponent).join(":");
}

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

function isReviewApprovalEvidence(value: unknown): value is ReviewApprovalEvidence {
  const record = asArguments(value);
  return (
    typeof record.diffHash === "string" &&
    typeof record.approvedAt === "number" &&
    (record.verification === undefined || isVerificationGateReceipt(record.verification)) &&
    (record.status === undefined || record.status === "approved" || record.status === "unverifiable") &&
    (record.warning === undefined || typeof record.warning === "string")
  );
}

function isPendingCompletion(value: unknown): value is PendingCompletionReceipt {
  const record = asArguments(value);
  return (
    typeof record.projectID === "string" &&
    typeof record.parentSessionID === "string" &&
    typeof record.missionID === "string" &&
    typeof record.workerSessionID === "string" &&
    typeof record.taskID === "string" &&
    typeof record.epicID === "string" &&
    typeof record.workerAgentID === "string" &&
    typeof record.workerAgentName === "string" &&
    typeof record.attemptCallID === "string" &&
    typeof record.dispatchToken === "string" &&
    typeof record.projectPath === "string" &&
    typeof record.summary === "string" &&
    typeof record.startTime === "number" &&
    Array.isArray(record.filesTouched) &&
    record.filesTouched.every((file) => typeof file === "string") &&
    typeof record.submittedAt === "number" &&
    (record.finalizing === undefined || typeof record.finalizing === "boolean") &&
    (record.finalized === undefined || typeof record.finalized === "boolean") &&
    (record.canceled === undefined || typeof record.canceled === "boolean") &&
    (record.cancelReason === undefined || typeof record.cancelReason === "string") &&
    (record.canceledAt === undefined || typeof record.canceledAt === "number") &&
    (record.amendedAt === undefined || typeof record.amendedAt === "number") &&
    (record.amendmentReason === undefined || typeof record.amendmentReason === "string") &&
    (record.verification === undefined || isVerificationGateReceipt(record.verification))
  );
}

function isScopedReviewReceipt(value: unknown): value is ScopedReviewReceipt {
  const record = asArguments(value);
  return (
    typeof record.projectID === "string" &&
    typeof record.sessionID === "string" &&
    typeof record.missionID === "string" &&
    typeof record.projectPath === "string" &&
    typeof record.epicID === "string" &&
    typeof record.taskID === "string" &&
    typeof record.assignedAgentID === "string" &&
    typeof record.assignedAgentName === "string" &&
    typeof record.attemptCallID === "string" &&
    typeof record.dispatchToken === "string" &&
    Array.isArray(record.filesTouched) &&
    record.filesTouched.every((file) => typeof file === "string") &&
    typeof record.diffHash === "string" &&
    typeof record.reviewedAt === "number" &&
    (record.approval === undefined || isReviewApprovalEvidence(record.approval))
  );
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

function backendReportedSuccess(output: unknown): boolean {
  const record = parseBackendObject(output);
  return record.success === true || record.ok === true;
}

function backendReportsAlreadyClosed(output: unknown, taskID: string): boolean {
  const record = parseBackendObject(output);
  return (
    record.success === false &&
    typeof record.error === "string" &&
    record.error.startsWith(`Bead already closed: ${taskID}`)
  );
}

/**
 * Extracts the completion verification receipt from a `swarm_complete` result.
 *
 * The backend returns `verification_gate: { passed, summary, steps }` on a
 * successful close. A skipped gate (`{skipped:true}`) or a payload without the
 * field yields `undefined`: approval is fail-closed without a real receipt.
 */
function parseCompletionVerificationReceipt(output: unknown): VerificationGateReceipt | undefined {
  const record = parseBackendObject(output);
  const gate = asArguments(record.verification_gate);
  if (gate.passed !== true) return undefined;
  const rawSteps = gate.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return undefined;
  const steps: VerificationGateStep[] = [];
  for (const raw of rawSteps) {
    const step = asArguments(raw);
    if (typeof step.name !== "string" || typeof step.passed !== "boolean") return undefined;
    if (step.skipped !== undefined && typeof step.skipped !== "boolean") return undefined;
    if (step.skipReason !== undefined && typeof step.skipReason !== "string") return undefined;
    steps.push({
      name: step.name,
      passed: step.passed,
      ...(step.skipped === undefined ? {} : { skipped: step.skipped }),
      ...(step.skipReason === undefined ? {} : { skipReason: step.skipReason }),
      ...(typeof step.command === "string" ? { command: step.command } : {}),
      ...(typeof step.exitCode === "number" ? { exitCode: step.exitCode } : {}),
      ...(typeof step.output === "string" ? { output: step.output } : {}),
    });
  }
  if (
    !steps.some((step) => step.skipped !== true) ||
    steps.some((step) => step.skipped !== true && !step.passed)
  ) {
    return undefined;
  }
  return {
    passed: true,
    summary: typeof gate.summary === "string" ? gate.summary : "",
    steps,
    recordedAt: Date.now(),
  };
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
): Promise<unknown> {
  return runtime.runTool(name, args, {
    ...(runtime.projectPath === undefined ? {} : { cwd: runtime.projectPath }),
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
    try {
      const r = Bun.spawnSync(["git", "diff", "--no-index", "/dev/null", fullPath], {
        cwd: projectRoot ?? process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = r.stdout.toString().trim();
      if (out.length > 0) {
        newFileDiff += (newFileDiff.length > 0 ? "\n" : "") + out;
      }
    } catch {
      // Best-effort.
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

async function activeMissionScope(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  tool: string,
): Promise<MissionScope & { readonly mission: MissionState }> {
  const scope = await requireMissionScope(tool, runtime, context);
  const mission = await readMission(scope.store, scope.projectID, scope.sessionID);
  if (mission === undefined || !mission.active) {
    throw new LocalToolError(tool, "not_found", "an active swarmx mission is required");
  }
  return { ...scope, mission };
}

async function recordScopedReview(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
  output: unknown,
): Promise<void> {
  const scope = await activeMissionScope(runtime, context, "swarm_review");
  const projectRoot = scope.projectRoot;
  if (projectRoot === undefined) {
    throw new LocalToolError("swarm_review", "runtime_unavailable", "active project root is not wired");
  }
  const taskID = requireStringInput("swarm_review", args, "task_id");
  const epicID = requireStringInput("swarm_review", args, "epic_id");
  const filesTouched = args.files_touched as string[];
  const check = checkScopedReviewDiff(output, filesTouched, projectRoot);
  if (!check.ok) {
    throw new LocalToolError("swarm_review", "conflict", scopedDiffFailureMessage(check.missing));
  }
  const diff = check.diff;

  const lockKey = [scope.projectID, scope.sessionID].map(encodeURIComponent).join(":");
  await withReviewDecisionLock(lockKey, async () => {
    const mission = await readMission(scope.store, scope.projectID, scope.sessionID);
    if (mission === undefined || !mission.active) {
      throw new LocalToolError("swarm_review", "conflict", "the mission changed while review was running");
    }
    const missionID = reviewMissionID(mission);
    const assignment = await resolveAssignment(
      scope.store,
      scope.projectID,
      taskID,
      undefined,
      { sessionID: scope.sessionID },
    );
    if (assignment === undefined) {
      throw new LocalToolError("swarm_review", "conflict", "the reviewed cell has no persisted agent assignment");
    }
    const assignedAgent = (await loadRosterEntries("swarm_review", runtime, context)).find(
      (agent) => agent.id === assignment || agent.name === assignment,
    );
    if (assignedAgent === undefined) {
      throw new LocalToolError("swarm_review", "agent_unknown", "the reviewed cell assignment is not in the V2 roster");
    }

    const pending = await readPendingCompletion(scope.store, scope.projectID, taskID);
    if (
      pending === undefined ||
      pending.parentSessionID !== scope.sessionID ||
      pending.missionID !== missionID ||
      pending.epicID !== epicID ||
      pending.workerAgentID !== assignedAgent.id ||
      !samePaths(pending.filesTouched, filesTouched)
    ) {
      throw new LocalToolError(
        "swarm_review",
        "conflict",
        "review requires the assigned worker's matching completion submission and file list",
      );
    }
    const receipt: ScopedReviewReceipt = {
      projectID: scope.projectID,
      sessionID: scope.sessionID,
      missionID,
      projectPath: projectRoot,
      epicID,
      taskID,
      assignedAgentID: assignedAgent.id,
      assignedAgentName: assignedAgent.name,
      attemptCallID: pending.attemptCallID,
      dispatchToken: pending.dispatchToken,
      filesTouched,
      diffHash: createHash("sha256").update(diff).digest("hex"),
      reviewedAt: Date.now(),
    };
    const key = reviewReceiptKey(scope.projectID, scope.sessionID, missionID, taskID);
    await withMissionLock(scope.projectID, scope.sessionID, async () => {
      const current = await readMission(scope.store, scope.projectID, scope.sessionID);
      if (current === undefined || !current.active || !sameMissionGeneration(current, mission)) {
        throw new LocalToolError("swarm_review", "conflict", "the mission changed while review was running");
      }
      const currentPending = await readPendingCompletion(scope.store, scope.projectID, taskID);
      if (
        currentPending === undefined ||
        currentPending.submittedAt !== pending.submittedAt ||
        currentPending.dispatchToken !== pending.dispatchToken ||
        currentPending.epicID !== epicID ||
        currentPending.workerAgentID !== assignedAgent.id ||
        !samePaths(currentPending.filesTouched, filesTouched)
      ) {
        throw new LocalToolError("swarm_review", "conflict", "the completion changed while review was running");
      }
      await scope.store.storage.set(key, receipt);
    });
  });
}

async function readScopedReview(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
): Promise<ScopedReviewReceipt> {
  const scope = await activeMissionScope(runtime, context, "swarm_review_feedback");
  const projectPath = await validateProjectRoot(runtime, "swarm_review_feedback", args.project_key);
  const taskID = requireStringInput("swarm_review_feedback", args, "task_id");
  const workerID = requireStringInput("swarm_review_feedback", args, "worker_id");
  const missionID = reviewMissionID(scope.mission);
  const key = reviewReceiptKey(scope.projectID, scope.sessionID, missionID, taskID);

  return withMissionLock(scope.projectID, scope.sessionID, async () => {
    const current = await readMission(scope.store, scope.projectID, scope.sessionID);
    if (current === undefined || !current.active || !sameMissionGeneration(current, scope.mission)) {
      throw new LocalToolError("swarm_review_feedback", "conflict", "the mission changed before review feedback");
    }
    const value = await scope.store.storage.get(key);
    if (
      isScopedReviewReceipt(value) &&
      value.projectID === scope.projectID &&
      value.sessionID === scope.sessionID &&
      value.missionID === missionID &&
      value.projectPath === projectPath &&
      value.taskID === taskID &&
      (workerID === value.assignedAgentID || workerID === value.assignedAgentName) &&
      value.filesTouched.length > 0 &&
      value.approval !== undefined
    ) {
      throw new LocalToolError(
        "swarm_review_feedback",
        "conflict",
        "the scoped review receipt was already consumed by an approval",
      );
    }
    if (
      !isScopedReviewReceipt(value) ||
      value.projectID !== scope.projectID ||
      value.sessionID !== scope.sessionID ||
      value.missionID !== missionID ||
      value.projectPath !== projectPath ||
      value.taskID !== taskID ||
      (workerID !== value.assignedAgentID && workerID !== value.assignedAgentName)
    ) {
      throw new LocalToolError(
        "swarm_review_feedback",
        "conflict",
        "a complete scoped review receipt is required before feedback",
      );
    }
    return value;
  });
}

async function removeScopedReviewReceipt(
  store: MissionStateStore,
  receipt: ScopedReviewReceipt,
  tool: string,
): Promise<void> {
  const key = reviewReceiptKey(receipt.projectID, receipt.sessionID, receipt.missionID, receipt.taskID);
  await withMissionLock(receipt.projectID, receipt.sessionID, async () => {
    const mission = await readMission(store, receipt.projectID, receipt.sessionID);
    const current = await store.storage.get(key);
    if (
      mission === undefined ||
      !mission.active ||
      reviewMissionID(mission) !== receipt.missionID ||
      !isScopedReviewReceipt(current) ||
      current.diffHash !== receipt.diffHash
    ) {
      throw new LocalToolError(tool, "conflict", "the scoped review receipt changed before it could be consumed");
    }
    await store.storage.remove(key);
  });
}

async function markPendingCompletionFinalized(
  store: MissionStateStore,
  receipt: ScopedReviewReceipt,
  pending: PendingCompletionReceipt,
): Promise<PendingCompletionReceipt> {
  const key = pendingCompletionKey(receipt.projectID, receipt.taskID);
  return withMissionLock(receipt.projectID, receipt.sessionID, async () => {
    const mission = await readMission(store, receipt.projectID, receipt.sessionID);
    const current = await readPendingCompletion(store, receipt.projectID, receipt.taskID);
    if (
      mission === undefined ||
      !mission.active ||
      reviewMissionID(mission) !== receipt.missionID ||
      current === undefined ||
      current.submittedAt !== pending.submittedAt
    ) {
      throw new LocalToolError("swarm_review_feedback", "conflict", "pending completion changed before finalization");
    }
    const finalized = { ...current, finalizing: false, finalized: true };
    await store.storage.set(key, finalized);
    return finalized;
  });
}

async function revokeWorkerAttempt(
  store: MissionStateStore,
  receipt: ScopedReviewReceipt,
  pending: PendingCompletionReceipt,
  tool: string,
): Promise<void> {
  await withMissionLock(receipt.projectID, receipt.sessionID, async () => {
    const mission = await readMission(store, receipt.projectID, receipt.sessionID);
    const attempt = await getAttempt(store, receipt.projectID, pending.attemptCallID);
    if (
      mission === undefined ||
      !mission.active ||
      reviewMissionID(mission) !== receipt.missionID ||
      attempt === undefined ||
      attempt.sessionID !== receipt.sessionID ||
      attempt.dispatchToken !== pending.dispatchToken
    ) {
      throw new LocalToolError(tool, "conflict", "the worker dispatch changed before it could be revoked");
    }
    if (attempt.revokedAt === undefined) {
      await putAttempt(store, receipt.projectID, { ...attempt, revokedAt: store.now() });
    }
  });
}

async function setPendingCompletionFinalizing(
  store: MissionStateStore,
  receipt: ScopedReviewReceipt,
  pending: PendingCompletionReceipt,
  finalizing: boolean,
): Promise<PendingCompletionReceipt> {
  const key = pendingCompletionKey(receipt.projectID, receipt.taskID);
  return withMissionLock(receipt.projectID, receipt.sessionID, async () => {
    const mission = await readMission(store, receipt.projectID, receipt.sessionID);
    const current = await readPendingCompletion(store, receipt.projectID, receipt.taskID);
    if (
      mission === undefined ||
      !mission.active ||
      reviewMissionID(mission) !== receipt.missionID ||
      current === undefined ||
      current.submittedAt !== pending.submittedAt ||
      current.finalized === true
    ) {
      throw new LocalToolError("swarm_review_feedback", "conflict", "pending completion changed before verification");
    }
    const updated = { ...current, finalizing };
    await store.storage.set(key, updated);
    return updated;
  });
}

/**
 * Persists the completion verification receipt before finalization.
 *
 * Keeping the receipt on the pending completion is what lets a retried approval
 * reuse the gate result when the backend reports the cell as already closed.
 */
async function recordPendingCompletionVerification(
  store: MissionStateStore,
  receipt: ScopedReviewReceipt,
  pending: PendingCompletionReceipt,
  verification: VerificationGateReceipt,
): Promise<PendingCompletionReceipt> {
  const key = pendingCompletionKey(receipt.projectID, receipt.taskID);
  return withMissionLock(receipt.projectID, receipt.sessionID, async () => {
    const mission = await readMission(store, receipt.projectID, receipt.sessionID);
    const current = await readPendingCompletion(store, receipt.projectID, receipt.taskID);
    if (
      mission === undefined ||
      !mission.active ||
      reviewMissionID(mission) !== receipt.missionID ||
      current === undefined ||
      current.submittedAt !== pending.submittedAt ||
      current.finalized === true
    ) {
      throw new LocalToolError(
        "swarm_review_feedback",
        "conflict",
        "pending completion changed before its verification receipt was recorded",
      );
    }
    const updated = { ...current, verification };
    await store.storage.set(key, updated);
    return updated;
  });
}

async function readPendingCompletion(
  store: MissionStateStore,
  projectID: string,
  taskID: string,
): Promise<PendingCompletionReceipt | undefined> {
  const value = await store.storage.get(pendingCompletionKey(projectID, taskID));
  return isPendingCompletion(value) ? value : undefined;
}

async function submitPendingCompletion(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
  worker: AssignedWorkerScope,
): Promise<ToolExecuteResult> {
  const store = runtime.store;
  const projectID = resolveProjectID(runtime);
  if (store === undefined || projectID === undefined || context.sessionID === undefined) {
    throw new LocalToolError("swarm_complete", "runtime_unavailable", "pending completion storage is not available");
  }
  const parentMission = worker.parentMission;
  const verification = parseWorkerVerification(args.verification);
  const receipt: PendingCompletionReceipt = {
    projectID,
    parentSessionID: parentMission.sessionID,
    missionID: reviewMissionID(parentMission),
    workerSessionID: context.sessionID,
    taskID: worker.marker.cellID,
    epicID: worker.marker.epicID,
    workerAgentID: worker.agent.id,
    workerAgentName: worker.agent.name,
    attemptCallID: worker.attemptCallID,
    dispatchToken: worker.marker.dispatchToken as string,
    projectPath: await canonicalProjectRoot("swarm_complete", runtime),
    summary: args.summary as string,
    startTime: typeof args.start_time === "number" ? args.start_time : Date.now(),
    filesTouched: Array.isArray(args.files_touched) ? (args.files_touched as string[]) : [],
    submittedAt: Date.now(),
    ...(verification === undefined ? {} : { verification }),
  };
  const key = pendingCompletionKey(projectID, receipt.taskID);
  await withMissionLock(projectID, parentMission.sessionID, async () => {
    const mission = await readMission(store, projectID, parentMission.sessionID);
    if (mission === undefined || !mission.active || !sameMissionGeneration(mission, parentMission)) {
      throw new LocalToolError("swarm_complete", "conflict", "the dispatch mission is no longer active");
    }
    const previous = await readPendingCompletion(store, projectID, receipt.taskID);
    if (
      previous?.finalizing === true &&
      previous.parentSessionID === receipt.parentSessionID &&
      previous.missionID === receipt.missionID &&
      previous.attemptCallID === receipt.attemptCallID
    ) {
      throw new LocalToolError("swarm_complete", "conflict", "completion finalization is already in progress");
    }
    if (
      previous?.finalized &&
      previous.parentSessionID === receipt.parentSessionID &&
      previous.missionID === receipt.missionID
    ) {
      throw new LocalToolError("swarm_complete", "conflict", "this cell was already finalized");
    }
    if (
      previous !== undefined &&
      previous.parentSessionID === receipt.parentSessionID &&
      previous.missionID === receipt.missionID &&
      previous.attemptCallID !== receipt.attemptCallID
    ) {
      throw new LocalToolError("swarm_complete", "conflict", "another dispatch attempt already submitted this cell");
    }
    if (
      previous !== undefined &&
      (previous.parentSessionID !== receipt.parentSessionID ||
        previous.missionID !== receipt.missionID ||
        previous.workerAgentID !== receipt.workerAgentID)
    ) {
      const previousMission = await readMission(store, projectID, previous.parentSessionID);
      if (previousMission?.active) {
        throw new LocalToolError("swarm_complete", "conflict", "another active dispatch owns the pending completion");
      }
    }
    await store.storage.set(key, receipt);
  });

  return {
    output: {
      success: true,
      status: "pending_review",
      bead_id: receipt.taskID,
      files_touched: receipt.filesTouched,
      message: "Completion submitted; the coordinator must review the scoped diff before finalization.",
    },
    content: `Completion for ${receipt.taskID} submitted; awaiting coordinator review.`,
  };
}

async function clearReviewState(
  store: MissionStateStore,
  receipt: ScopedReviewReceipt,
  pending: PendingCompletionReceipt,
  keepFinalized: boolean,
  approval?: ReviewApprovalEvidence,
): Promise<void> {
  const reviewKey = reviewReceiptKey(receipt.projectID, receipt.sessionID, receipt.missionID, receipt.taskID);
  const completionKey = pendingCompletionKey(receipt.projectID, receipt.taskID);
  await withMissionLock(receipt.projectID, receipt.sessionID, async () => {
    const mission = await readMission(store, receipt.projectID, receipt.sessionID);
    const currentReview = await store.storage.get(reviewKey);
    const currentCompletion = await readPendingCompletion(store, receipt.projectID, receipt.taskID);
    if (
      mission === undefined ||
      !mission.active ||
      reviewMissionID(mission) !== receipt.missionID ||
      !isScopedReviewReceipt(currentReview) ||
      currentReview.diffHash !== receipt.diffHash ||
      currentReview.approval !== undefined ||
      currentCompletion === undefined ||
      currentCompletion.submittedAt !== pending.submittedAt ||
      (keepFinalized && currentCompletion.finalized !== true)
    ) {
      throw new LocalToolError("swarm_review_feedback", "conflict", "review state changed before it could be cleared");
    }
    if (approval === undefined) {
      await store.storage.remove(reviewKey);
    } else {
      // Approval evidence stays readable in the review receipt: the diff that
      // was approved plus the completion gate receipt that backed it.
      await store.storage.set(reviewKey, { ...currentReview, approval });
    }
    if (!keepFinalized) await store.storage.remove(completionKey);
  });
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
  backendName: string,
): Promise<ToolExecuteResult> {
  const scope = await requireMissionScope("swarm_review_feedback", runtime, context);
  const taskID = requireStringInput("swarm_review_feedback", args, "task_id");
  const key = [scope.projectID, scope.sessionID].map(encodeURIComponent).join(":");
  return withReviewDecisionLock(key, () => executeReviewFeedbackLocked(runtime, context, args, backendName));
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
): Promise<EpicChildCell[]> {
  // `parent_id` is a first-class filter of the backend `hive_cells` schema
  // (opencode-swarm-plugin/src/hive.ts: `parent_id` → adapter.queryCells), and
  // the local catalog spec declares it too, so the CLI forwards it verbatim.
  const output = await runToolForSession(
    runtime,
    "hive_cells",
    {
      ...(runtime.projectPath === undefined ? {} : { project_key: runtime.projectPath }),
      parent_id: epicID,
      limit: 200,
    },
    sessionID,
    60_000,
  );
  return parseEpicCells(output);
}

/**
 * Completes the Hive half of the reviewed local fallback.
 *
 * The normal backend `swarm_complete` path closes the cell itself. When that
 * path reports `Bead not found`, approval must also close the cell in the
 * active project and read the terminal status back. Code cells require local
 * checks to pass; doc-only cells use the existing explicit `unverifiable` path.
 */
async function closeHiveCellAfterFallback(
  runtime: SwarmxRuntime,
  sessionID: string,
  pending: PendingCompletionReceipt,
): Promise<void> {
  let closeError: unknown;
  try {
    await runToolForSession(
      runtime,
      "hive_close",
      { id: pending.taskID, reason: `Locally verified and approved: ${pending.summary}` },
      sessionID,
      120_000,
    );
  } catch (error) {
    // The cell may already be closed if the CLI lost the close response.
    closeError = error;
  }

  let cell: EpicChildCell | undefined;
  try {
    cell = (await listEpicChildCells(runtime, sessionID, pending.epicID)).find(
      (candidate) => candidate.id === pending.taskID,
    );
  } catch (error) {
    closeError ??= error;
  }
  if (cell !== undefined && isConsolidationCellFinished(cell.status)) return;

  const detail = closeError instanceof Error ? `: ${closeError.message}` : "";
  throw new LocalToolError(
    "swarm_review_feedback",
    "conflict",
    `Hive cell ${pending.taskID} is not closed after local verification${detail}`,
  );
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
  store: MissionStateStore,
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
  await setAssignment(store, scope.projectID, cellID, SWARM_WORKER_AGENT_ID, {
    sessionID: scope.sessionID,
  });
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

async function executeReviewFeedbackLocked(
  runtime: SwarmxRuntime,
  context: ToolExecuteContextLike,
  args: Record<string, unknown>,
  backendName: string,
): Promise<ToolExecuteResult> {
  const receipt = await readScopedReview(runtime, context, args);
  const store = runtime.store;
  if (store === undefined) {
    throw new LocalToolError("swarm_review_feedback", "runtime_unavailable", "mission storage is not wired");
  }
  let pending = await readPendingCompletion(store, receipt.projectID, receipt.taskID);
  if (
    pending === undefined ||
    pending.projectID !== receipt.projectID ||
    pending.parentSessionID !== receipt.sessionID ||
    pending.missionID !== receipt.missionID ||
    pending.taskID !== receipt.taskID ||
    pending.epicID !== receipt.epicID ||
    pending.projectPath !== receipt.projectPath ||
    pending.workerAgentID !== receipt.assignedAgentID ||
    pending.workerAgentName !== receipt.assignedAgentName ||
    pending.attemptCallID !== receipt.attemptCallID ||
    pending.dispatchToken !== receipt.dispatchToken ||
    pending.submittedAt > receipt.reviewedAt ||
    !samePaths(pending.filesTouched, receipt.filesTouched)
  ) {
    throw new LocalToolError(
      "swarm_review_feedback",
      "conflict",
      "a matching worker completion submission is required before review feedback",
    );
  }
  if (args.status === "needs_changes" && (pending.finalized || pending.finalizing)) {
    throw new LocalToolError(
      "swarm_review_feedback",
      "conflict",
      "a finalizing or finalized cell cannot be sent back for changes",
    );
  }

  const currentDiff = await runToolForSession(
    runtime,
    "swarm_review",
    {
      project_key: receipt.projectPath,
      epic_id: receipt.epicID,
      task_id: receipt.taskID,
      files_touched: receipt.filesTouched,
    },
    receipt.sessionID,
    120_000,
  );
  const check = checkScopedReviewDiff(currentDiff, receipt.filesTouched);
  if (!check.ok) {
    throw new LocalToolError("swarm_review_feedback", "conflict", scopedDiffFailureMessage(check.missing));
  }
  if (createHash("sha256").update(check.diff).digest("hex") !== receipt.diffHash) {
    throw new LocalToolError(
      "swarm_review_feedback",
      "conflict",
      "the diff changed after review; request a fresh review before feedback",
    );
  }

  const docOnly = receipt.filesTouched.every(isDocOnlyPath);
  let unverifiable = false;
  let completionOutput: unknown;
  let verificationReceipt: VerificationGateReceipt | undefined;
  if ((args.status === "approved" || args.status === "unverifiable") && pending.finalized !== true) {
    const recoveringFinalization = pending.finalizing === true;
    if (!recoveringFinalization) {
      pending = await setPendingCompletionFinalizing(store, receipt, pending, true);
    }
    completionOutput = await runToolForSession(
      runtime,
      "swarm_complete",
      {
        project_key: pending.projectPath,
        agent_name: pending.workerAgentName,
        bead_id: pending.taskID,
        summary: pending.summary,
        start_time: pending.startTime,
        files_touched: pending.filesTouched,
        skip_review: true,
      },
      pending.workerSessionID,
      120_000,
    );
    if (
      !backendReportedSuccess(completionOutput) &&
      JSON.stringify(completionOutput).includes("Bead not found")
    ) {
      const localVerdict = runLocalVerification(pending.projectPath, pending.filesTouched);
      completionOutput = {
        success: localVerdict.passed,
        verification_gate: {
          passed: localVerdict.passed,
          summary: localVerdict.summary,
          steps: localVerdict.steps,
        },
      };
      if (localVerdict.passed || docOnly) {
        try {
          await closeHiveCellAfterFallback(runtime, receipt.sessionID, pending);
        } catch (error) {
          await setPendingCompletionFinalizing(store, receipt, pending, false);
          const message = error instanceof Error ? error.message : String(error);
          throw new LocalToolError("swarm_review_feedback", "conflict", message);
        }
      }
    }
    const previouslyClosed = backendReportsAlreadyClosed(completionOutput, pending.taskID);
    if (!backendReportedSuccess(completionOutput) && !(recoveringFinalization && previouslyClosed)) {
      if (docOnly) {
        // Doc-only cells (assets/docs/*.md) cannot run the verification gate;
        // approve them as unverifiable instead of failing the review.
        unverifiable = true;
      } else {
        await setPendingCompletionFinalizing(store, receipt, pending, false);
        throw new LocalToolError(
          "swarm_review_feedback",
          "conflict",
          "the completion verification gate failed; the cell remains pending review",
        );
      }
    }
    if (backendReportedSuccess(completionOutput)) {
      verificationReceipt = parseCompletionVerificationReceipt(completionOutput);
      if (verificationReceipt === undefined) {
        if (docOnly) {
          unverifiable = true;
        } else {
          if (!recoveringFinalization) {
            await setPendingCompletionFinalizing(store, receipt, pending, false);
          }
          throw new LocalToolError(
            "swarm_review_feedback",
            "conflict",
            "the completion returned no verification receipt; review approval is blocked",
          );
        }
      } else {
        pending = await recordPendingCompletionVerification(store, receipt, pending, verificationReceipt);
      }
    } else {
      // Recovery after a crash: the backend already closed the cell, so reuse
      // the receipt captured by the original successful completion.
      verificationReceipt = pending.verification;
      if (verificationReceipt === undefined && docOnly) {
        unverifiable = true;
      }
    }
    if (verificationReceipt === undefined && !docOnly) {
      throw new LocalToolError(
        "swarm_review_feedback",
        "conflict",
        "a completion verification receipt is required before review approval",
      );
    }
    pending = await markPendingCompletionFinalized(store, receipt, pending);
  }
  if (args.status === "approved" || args.status === "unverifiable") {
    verificationReceipt ??= pending.verification;
    if (verificationReceipt === undefined) {
      if (docOnly) {
        unverifiable = true;
      } else {
        throw new LocalToolError(
          "swarm_review_feedback",
          "conflict",
          "a completion verification receipt is required before review approval",
        );
      }
    }
    await revokeWorkerAttempt(store, receipt, pending, "swarm_review_feedback");
  }
  if (args.status === "needs_changes") {
    await revokeWorkerAttempt(store, receipt, pending, "swarm_review_feedback");
  }

  const feedbackOutput = await runToolForSession(runtime, backendName, args, receipt.sessionID, 120_000);
  if (!backendReportedSuccess(feedbackOutput)) {
    throw new LocalToolError("swarm_review_feedback", "conflict", "the backend did not accept review feedback");
  }
  const approvalWarning =
    unverifiable ? "Verification receipt unavailable; approved as unverifiable (documentation/assets only)." : undefined;
  const approval: ReviewApprovalEvidence | undefined =
    (args.status === "approved" || args.status === "unverifiable")
      ? {
          diffHash: receipt.diffHash,
          ...(verificationReceipt === undefined ? {} : { verification: verificationReceipt }),
          approvedAt: Date.now(),
          status: verificationReceipt === undefined ? "unverifiable" : "approved",
          ...(approvalWarning === undefined ? {} : { warning: approvalWarning }),
        }
      : undefined;
  await clearReviewState(store, receipt, pending, args.status === "approved" || args.status === "unverifiable", approval);
  if (args.status === "approved" || args.status === "unverifiable") {
    emitDecision(runtime.sessionEvents, {
      sessionID: receipt.sessionID,
      epicID: receipt.epicID,
      decisionType: "review_approved",
      payload: {
        task_id: receipt.taskID,
        status: args.status,
        unverifiable,
        ...(approval?.diffHash === undefined ? {} : { diff_hash: approval.diffHash }),
      },
    });
  }
  let consolidation: ConsolidationState | undefined;
  let consolidationError: string | undefined;
  if (args.status === "approved" || args.status === "unverifiable") {
    try {
      consolidation = await maybePrepareConsolidation(store, {
        projectID: receipt.projectID,
        sessionID: receipt.sessionID,
        epicID: receipt.epicID,
        listCells: (epicID) => listEpicChildCells(runtime, receipt.sessionID, epicID),
        prepareCell: (cells) =>
          prepareConsolidationCell(
            runtime,
            store,
            {
              projectID: receipt.projectID,
              sessionID: receipt.sessionID,
              epicID: receipt.epicID,
              files: receipt.filesTouched,
            },
            cells,
          ),
      });
    } catch (error) {
      // Consolidation is best effort: the approval itself already succeeded.
      consolidationError = error instanceof Error ? error.message : String(error);
    }
    // Approving the consolidation cell itself closes the loop: the mission may
    // now finish (see `assertConsolidationComplete`).
    try {
      const completed = await completeConsolidation(store, {
        projectID: receipt.projectID,
        sessionID: receipt.sessionID,
        cellID: receipt.taskID,
      });
      if (completed !== undefined) consolidation = completed;
    } catch (error) {
      consolidationError = error instanceof Error ? error.message : String(error);
    }
    if (consolidation !== undefined) {
      emitDecision(runtime.sessionEvents, {
        sessionID: receipt.sessionID,
        epicID: consolidation.epicID,
        decisionType:
          consolidation.status === "completed" ? "consolidation_completed" : "consolidation_ready",
        payload: { cell_id: consolidation.cellID, status: consolidation.status },
      });
    }
  }
  return {
    output: {
      review_feedback: feedbackOutput,
      ...(completionOutput === undefined ? {} : { completion: completionOutput }),
      ...(approval === undefined
        ? {}
        : {
            approval_evidence: {
              diff_hash: approval.diffHash,
              ...(approval.verification === undefined ? {} : { verification: approval.verification }),
              status: approval.status,
              ...(approval.warning === undefined ? {} : { warning: approval.warning }),
            },
          }),
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
      ...(unverifiable
        ? {
            status: "unverifiable",
            warning: approvalWarning,
          }
        : {}),
    },
    content: args.status === "approved" || args.status === "unverifiable"
      ? unverifiable
        ? `Cell ${receipt.taskID} approved and finalized. Warning: verification receipt unavailable; marked unverifiable.`
        : `Cell ${receipt.taskID} approved and finalized.`
      : `Review feedback recorded for ${receipt.taskID}.`,
  };
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

  const { store, projectID } = requireStoreProject(tool, runtime);
  const assignment = await resolveAssignment(store, projectID, marker.cellID, undefined, {
    sessionID: parentSessionID,
  });
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
  const { store, projectID } = requireStoreProject(tool, runtime);
  const mission = await readMission(store, projectID, parentSessionID);
  if (mission === undefined || !mission.active) {
    throw new LocalToolError(tool, "conflict", "the worker session's parent has no active swarmx mission");
  }
  const attempts = await listAttempts(store, projectID, parentSessionID, mission);
  const attempt = attempts.find(
    (attempt) =>
      attempt.cellID === worker.marker.cellID &&
      attempt.epicID === worker.marker.epicID &&
      attempt.agent === worker.agent.id &&
      attempt.dispatchToken === worker.marker.dispatchToken &&
      attempt.revokedAt === undefined &&
      (attempt.status === "pending" || attempt.status === "succeeded"),
  );
  if (attempt === undefined) {
    const detail = `cell=${worker.marker.cellID} epic=${worker.marker.epicID} agent=${worker.agent.id} token=${worker.marker.dispatchToken ?? "none"} attempts=${attempts.length} (revoked=${attempts.filter((a) => a.revokedAt !== undefined).length})`;
    throw new LocalToolError(tool, "conflict", `the worker prompt is not bound to a dispatched cell in its parent mission (${detail})`);
  }

  const boundAttempt = await withMissionLock(projectID, parentSessionID, async () => {
    const currentMission = await readMission(store, projectID, parentSessionID);
    const currentAttempt = await getAttempt(store, projectID, attempt.callID);
    if (
      currentMission === undefined ||
      !currentMission.active ||
      !sameMissionGeneration(currentMission, mission) ||
      currentAttempt === undefined ||
      currentAttempt.dispatchToken !== worker.marker.dispatchToken ||
      currentAttempt.revokedAt !== undefined ||
      (currentAttempt.status !== "pending" && currentAttempt.status !== "succeeded")
    ) {
      throw new LocalToolError(tool, "conflict", "the dispatch capability is no longer active");
    }
    if (currentAttempt.workerSessionID !== undefined && currentAttempt.workerSessionID !== workerSessionID) {
      throw new LocalToolError(
        tool,
        "conflict",
        "the dispatch capability is already bound to another worker session",
      );
    }
    if (currentAttempt.workerSessionID === undefined) {
      const bound = { ...currentAttempt, workerSessionID };
      await putAttempt(store, projectID, bound);
      return bound;
    }
    return currentAttempt;
  });
  return { parentMission: mission, attemptCallID: boundAttempt.callID };
}

function requireAssignedAgentName(tool: string, value: unknown, agent: RosterAgent): void {
  if (value !== agent.id && value !== agent.name) {
    throw new LocalToolError(tool, "conflict", "agent_name does not match the caller assigned to this cell");
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
  if (runtime.store === undefined || projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify active project missions");
  }
  let missions: readonly MissionState[];
  try {
    missions = await runtime.store.list();
  } catch {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify active project missions");
  }
  if (missions.some((mission) => mission.projectID === projectID && mission.active)) {
    throw new LocalToolError(
      tool,
      "conflict",
      "active swarmx cells close only through an approved swarm_complete call",
    );
  }
  // finishMission refuses to close with unrevoked attempts, so a closed mission
  // cannot hide a pending attempt; scanning all project attempts also covers
  // orphaned ledger entries whose mission document was removed.
  const attempts = await listAttempts(runtime.store, projectID);
  if (
    attempts.some(
      (attempt) =>
        attempt.revokedAt === undefined &&
        (attempt.status === "pending" || attempt.status === "succeeded"),
    )
  ) {
    throw new LocalToolError(tool, "conflict", "the project still has unrevoked worker attempts");
  }
}

async function requireNoActiveTaskAttempt(
  runtime: SwarmxRuntime,
  tool: string,
  taskID: string,
): Promise<void> {
  const projectID = resolveProjectID(runtime);
  if (runtime.store === undefined || projectID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify active task attempts");
  }
  const attempts = await listAttempts(runtime.store, projectID);
  if (
    attempts.some(
      (attempt) =>
        attempt.cellID === taskID &&
        attempt.revokedAt === undefined &&
        (attempt.status === "pending" || attempt.status === "succeeded"),
    )
  ) {
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
  const store = runtime.store;
  if (store === undefined || projectID === undefined) {
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
  const claimKey = `cleanup-claim:${projectID}`;
  // Short-lived marker: gateBefore ignores it after 5 minutes, so a crash
  // fails closed only briefly. The key is reused per project.
  await store.storage.set(claimKey, { taskID: claimTaskID, at: Date.now() });
  try {
    const missions = (await store.list())
      .filter((mission) => mission.projectID === projectID)
      .sort((left, right) => left.sessionID.localeCompare(right.sessionID));

    const operation = async (): Promise<ToolExecuteResult> => {
      if (normalized.cleanup_all === true) {
        await requireNoActiveProjectMission(runtime, "swarm_worktree_cleanup");
      } else {
        await requireNoActiveTaskAttempt(runtime, "swarm_worktree_cleanup", claimTaskID);
      }
      return { output: await runToolForSession(runtime, backendName, normalized, sessionID, 120_000) };
    };

    let run = operation;
    for (const mission of [...missions].reverse()) {
      const previous = run;
      run = () => withMissionLock(projectID, mission.sessionID, previous);
    }
    return await run();
  } finally {
    await store.storage.remove(claimKey).catch(() => undefined);
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
  if (runtime.store === undefined || projectID === undefined || sessionID === undefined) {
    throw new LocalToolError(tool, "runtime_unavailable", "cannot verify the mission owner");
  }
  const mission = await readMission(runtime.store, projectID, sessionID);
  const ownsActiveMission = mission !== undefined && mission.active;
  if (!ownsActiveMission || (await resolveCallerMode(runtime, context, tool)) !== "primary") {
    throw new LocalToolError(tool, "conflict", "only the canonical swarm coordinator may use this tool");
  }
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
  if (requestedName !== undefined && requestedName !== caller.id && requestedName !== caller.name) {
    throw new LocalToolError("swarmmail_init", "conflict", "agent_name must match the V2 caller");
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
    return submitPendingCompletion(runtime, context, args, scope);
  }
  if (spec.name === "swarmmail_init") {
    args = await bindSwarmMailIdentity(runtime, context, args);
  }
  if (spec.name === "swarmmail_release") {
    await restrictSwarmMailRelease(runtime, context, args);
  }
  if (spec.name === "hive_close") {
    await requireNoActiveProjectMission(runtime, "hive_close");
  }
  if (spec.name === "hive_update") {
    await restrictHiveUpdate(runtime, context, args);
  }
  if (spec.name === "swarm_progress") {
    args = await restrictWorkerProgress(runtime, context, args);
  }
  if (spec.name === "swarm_review") {
    args = await validateReviewScope(runtime, args);
    await activeMissionScope(runtime, context, "swarm_review");
  }
  if (spec.name === "swarm_review_feedback") {
    const backendName = spec.backendName;
    if (backendName === undefined) {
      throw new UnsupportedToolError(spec.name, "backendName manquant dans le catalogue");
    }
    return executeReviewFeedback(runtime, context, args, backendName);
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
        // can still persist a scoped review receipt and finalize the cell.
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
        await recordScopedReview(runtime, context, args, output);
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
