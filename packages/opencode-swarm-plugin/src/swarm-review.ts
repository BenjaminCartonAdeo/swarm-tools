/**
 * Swarm Structured Review Module
 *
 * Provides coordinator-driven review of worker output before completion.
 * The review is epic-aware - it checks if work serves the overall goal
 * and enables downstream tasks.
 *
 * Key features:
 * - Generate review prompts with full epic context
 * - Track review attempts (max 5 before task fails)
 * - Send structured feedback to workers
 * - Gate completion on review approval
 *
 * Credit: Review patterns inspired by https://github.com/nexxeln/opencode-config
 */

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { sendSwarmMessage, type HiveAdapter } from "swarm-mail";
import { getHiveAdapter } from "./hive";
import { captureCoordinatorEvent } from "./eval-capture.js";
import { traceReviewDecision } from "./decision-trace-integration.js";

// ============================================================================
// Types & Schemas
// ============================================================================

/**
 * Review issue - a specific problem found during review
 */
export interface ReviewIssue {
  file: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

export const ReviewIssueSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  issue: z.string(),
  suggestion: z.string().optional(),
});

/**
 * Review result - the outcome of a review
 */
export interface ReviewResult {
  status: "approved" | "needs_changes";
  summary?: string;
  issues?: ReviewIssue[];
  remaining_attempts?: number;
}

export const ReviewResultSchema = z
  .object({
    status: z.enum(["approved", "needs_changes"]),
    summary: z.string().optional(),
    issues: z.array(ReviewIssueSchema).optional(),
    remaining_attempts: z.number().optional(),
  })
  .refine(
    (data) => {
      // If status is needs_changes, issues must be provided
      if (data.status === "needs_changes") {
        return data.issues && data.issues.length > 0;
      }
      return true;
    },
    {
      message: "issues array is required when status is 'needs_changes'",
    }
  );

/**
 * Dependency info for review context
 */
export interface DependencyInfo {
  id: string;
  title: string;
  summary?: string;
}

/**
 * Downstream task info
 */
export interface DownstreamTask {
  id: string;
  title: string;
}

/**
 * Review prompt context
 */
export interface ReviewPromptContext {
  epic_id: string;
  epic_title: string;
  epic_description?: string;
  task_id: string;
  task_title: string;
  task_description?: string;
  files_touched: string[];
  diff: string;
  completed_dependencies?: DependencyInfo[];
  downstream_tasks?: DownstreamTask[];
}

// ============================================================================
// Review Attempt Tracking
// ============================================================================

/**
 * In-memory tracking of review attempts per task
 * Key: task_id, Value: attempt count
 */
const reviewAttempts = new Map<string, number>();

const MAX_REVIEW_ATTEMPTS = 3;

/**
 * Get current attempt count for a task
 */
function getAttemptCount(taskId: string): number {
  return reviewAttempts.get(taskId) || 0;
}

/**
 * Increment attempt count for a task
 * @returns New attempt count
 */
function incrementAttempt(taskId: string): number {
  const current = getAttemptCount(taskId);
  const newCount = current + 1;
  reviewAttempts.set(taskId, newCount);
  return newCount;
}

/**
 * Clear attempt count (on success or task reset)
 */
function clearAttempts(taskId: string): void {
  reviewAttempts.delete(taskId);
}

/**
 * Get remaining attempts
 */
function getRemainingAttempts(taskId: string): number {
  return MAX_REVIEW_ATTEMPTS - getAttemptCount(taskId);
}

// ============================================================================
// Review Prompt Generation
// ============================================================================

/**
 * Generate a review prompt with full epic context
 *
 * The prompt includes:
 * - Epic goal (big picture)
 * - Task requirements
 * - Dependency context (what this builds on)
 * - Downstream context (what depends on this)
 * - The actual code diff
 * - Review criteria checklist
 */
export function generateReviewPrompt(context: ReviewPromptContext): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Code Review: ${context.task_title}`);
  sections.push("");

  // Epic context (big picture)
  sections.push("## Epic Goal");
  sections.push(`**${context.epic_title}**`);
  if (context.epic_description) {
    sections.push(context.epic_description);
  }
  sections.push("");

  // Task requirements
  sections.push("## Task Requirements");
  sections.push(`**${context.task_title}**`);
  if (context.task_description) {
    sections.push(context.task_description);
  }
  sections.push("");

  // Dependency context
  if (
    context.completed_dependencies &&
    context.completed_dependencies.length > 0
  ) {
    sections.push("## This Task Builds On");
    for (const dep of context.completed_dependencies) {
      sections.push(`- **${dep.title}** (${dep.id})`);
      if (dep.summary) {
        sections.push(`  ${dep.summary}`);
      }
    }
    sections.push("");
  }

  // Downstream context
  if (context.downstream_tasks && context.downstream_tasks.length > 0) {
    sections.push("## Downstream Tasks (depend on this)");
    for (const task of context.downstream_tasks) {
      sections.push(`- **${task.title}** (${task.id})`);
    }
    sections.push("");
  }

  // Files touched
  sections.push("## Files Modified");
  for (const file of context.files_touched) {
    sections.push(`- \`${file}\``);
  }
  sections.push("");

  // Code diff
  sections.push("## Code Changes");
  sections.push("```diff");
  sections.push(context.diff);
  sections.push("```");
  sections.push("");

  // Review criteria
  sections.push("## Review Criteria");
  sections.push("");
  sections.push("Please evaluate the changes against these criteria:");
  sections.push("");
  sections.push(
    "1. **Fulfills Requirements**: Does the code implement what the task requires?"
  );
  sections.push(
    "2. **Serves Epic Goal**: Does this work contribute to the overall epic objective?"
  );
  sections.push(
    "3. **Enables Downstream**: Can downstream tasks use this work as expected?"
  );
  sections.push("4. **Type Safety**: Are types correct and complete?");
  sections.push("5. **No Critical Bugs**: Are there any obvious bugs or issues?");
  sections.push(
    "6. **Test Coverage**: Are there tests for the new code? (warning only)"
  );
  sections.push("");

  // Response format
  sections.push("## Response Format");
  sections.push("");
  sections.push("Respond with a JSON object:");
  sections.push("```json");
  sections.push(`{
  "status": "approved" | "needs_changes",
  "summary": "Brief summary of your review",
  "issues": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "issue": "Description of the problem",
      "suggestion": "How to fix it"
    }
  ]
}`);
  sections.push("```");

  return sections.join("\n");
}

// ============================================================================
// HiveAdapter Helper
// ============================================================================

/**
 * Get or create a HiveAdapter for a project (safe wrapper)
 */
async function getHiveAdapterSafe(projectPath: string): Promise<HiveAdapter | null> {
  try {
    return getHiveAdapter(projectPath);
  } catch {
    return null;
  }
}

/**
 * Get dependencies for a cell by querying all cells and checking their parent_id
 * Note: This is a simplified approach - a full implementation would use the dependency graph
 */
async function getCellDependencies(
  adapter: HiveAdapter,
  projectKey: string,
  _cellId: string,
  epicId: string
): Promise<{ completed: DependencyInfo[]; downstream: DownstreamTask[] }> {
  const completedDependencies: DependencyInfo[] = [];
  const downstreamTasks: DownstreamTask[] = [];

  try {
    // Get all subtasks of the epic
    const subtasks = await adapter.queryCells(projectKey, { parent_id: epicId });
    
    for (const subtask of subtasks) {
      // Skip the current task
      if (subtask.id === _cellId) continue;

      // Completed tasks are potential dependencies
      if (subtask.status === "closed") {
        completedDependencies.push({
          id: subtask.id,
          title: subtask.title,
          summary: subtask.closed_reason ?? undefined,
        });
      }
      
      // For downstream, we'd need to check the dependency graph
      // For now, we include all non-closed tasks as potential downstream
      if (subtask.status !== "closed") {
        downstreamTasks.push({
          id: subtask.id,
          title: subtask.title,
        });
      }
    }
  } catch {
    // Continue without dependency info
  }

  return { completed: completedDependencies, downstream: downstreamTasks };
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Generate a review prompt for a completed subtask
 *
 * Fetches epic and task details, gets the git diff, and generates
 * a comprehensive review prompt.
 */
export const swarm_review = tool({
  description:
    "Generate a review prompt for a completed subtask. Includes epic context, dependencies, and diff.",
  args: {
    project_key: z.string().describe("Project path"),
    epic_id: z.string().describe("Epic cell ID"),
    task_id: z.string().describe("Subtask cell ID to review"),
    files_touched: z
      .array(z.string())
      .optional()
      .describe("Files modified (will get diff for these)"),
  },
  async execute(args): Promise<string> {
    let epicTitle = args.epic_id;
    let epicDescription: string | undefined;
    let taskTitle = args.task_id;
    let taskDescription: string | undefined;
    let completedDependencies: DependencyInfo[] = [];
    let downstreamTasks: DownstreamTask[] = [];

    // Try to get cell details from HiveAdapter
    const adapter = await getHiveAdapterSafe(args.project_key);
    if (adapter) {
      try {
        // Get epic details
        const epic = await adapter.getCell(args.project_key, args.epic_id);
        if (epic) {
          epicTitle = epic.title || epicTitle;
          epicDescription = epic.description ?? undefined;
        }

        // Get task details
        const task = await adapter.getCell(args.project_key, args.task_id);
        if (task) {
          taskTitle = task.title || taskTitle;
          taskDescription = task.description ?? undefined;
        }

        // Get dependencies
        const deps = await getCellDependencies(
          adapter,
          args.project_key,
          args.task_id,
          args.epic_id
        );
        completedDependencies = deps.completed;
        downstreamTasks = deps.downstream;
      } catch {
        // Continue with defaults if adapter fails
      }
    }

    // Get git diff for files
    let diff = "";
    if (args.files_touched && args.files_touched.length > 0) {
      try {
        const diffResult = await Bun.$`git diff HEAD~1 -- ${args.files_touched}`
          .cwd(args.project_key)
          .quiet()
          .nothrow();

        if (diffResult.exitCode === 0) {
          diff = diffResult.stdout.toString();
        } else {
          // Try staged diff
          const stagedResult =
            await Bun.$`git diff --cached -- ${args.files_touched}`
              .cwd(args.project_key)
              .quiet()
              .nothrow();
          diff = stagedResult.stdout.toString();
        }
      } catch {
        // Git diff failed, continue without it
      }

      // Include untracked (new) file contents in the review diff
      try {
        const { execSync } = await import("child_process");
        const untracked: string[] = [];
        for (const f of args.files_touched || []) {
          try {
            execSync(`git ls-files --error-unmatch ${JSON.stringify(f)}`, { cwd: args.project_key, stdio: "ignore" });
          } catch {
            untracked.push(f);
          }
        }
        if (untracked.length > 0) {
          let extra = "\\n\\n--- Untracked (new) files ---\\n";
          for (const f of untracked) {
            try {
              const fs = await import("node:fs");
              const path = await import("node:path");
              const full = path.join(args.project_key, f);
              const content = fs.readFileSync(full, "utf-8");
              extra += `\\n### ${f}\\n${content}\\n`;
            } catch {}
          }
          diff += extra;
        }
      } catch {}
    }

    // Generate the review prompt
    const reviewPrompt = generateReviewPrompt({
      epic_id: args.epic_id,
      epic_title: epicTitle,
      epic_description: epicDescription,
      task_id: args.task_id,
      task_title: taskTitle,
      task_description: taskDescription,
      files_touched: args.files_touched || [],
      diff: diff || "(no diff available)",
      completed_dependencies:
        completedDependencies.length > 0 ? completedDependencies : undefined,
      downstream_tasks:
        downstreamTasks.length > 0 ? downstreamTasks : undefined,
    });

    // Emit ReviewStartedEvent for lifecycle tracking
    try {
      const { createEvent, appendEvent } = await import("swarm-mail");
      const attempt = getReviewStatus(args.task_id).attempt_count || 1;
      const reviewStartedEvent = createEvent("review_started", {
        project_key: args.project_key,
        epic_id: args.epic_id,
        bead_id: args.task_id,
        attempt,
      });
      await appendEvent(reviewStartedEvent, args.project_key);
    } catch (error) {
      // Non-fatal - log and continue
      console.warn("[swarm_review] Failed to emit ReviewStartedEvent:", error);
    }

    return JSON.stringify(
      {
        review_prompt: reviewPrompt,
        context: {
          epic_id: args.epic_id,
          epic_title: epicTitle,
          task_id: args.task_id,
          task_title: taskTitle,
          files_touched: args.files_touched || [],
          completed_dependencies: completedDependencies.length,
          downstream_tasks: downstreamTasks.length,
          remaining_attempts: getRemainingAttempts(args.task_id),
        },
      },
      null,
      2
    );
  },
});

/** Stable identity of this host process for durable feedback claims. */
const HOST_INSTANCE_ID = randomUUID();

interface KeyedFeedbackArgs {
  project_key: string;
  task_id: string;
  worker_id: string;
  status: "approved" | "needs_changes";
  summary?: string;
  operation_id: string;
}

/**
 * Operation-keyed swarm_review_feedback.
 *
 * The durable claim (global DB) allocates the attempt once per operation_id
 * before any side effect; replays return the saved result. Side effects use
 * deterministic idempotency keys: operation_id for the review_completed event
 * and decision trace, `${operation_id}:worker-message` for the worker mail.
 * Never reads or writes the process-local reviewAttempts/reviewStatus maps.
 */
async function executeKeyedReviewFeedback(
  args: KeyedFeedbackArgs,
  parsedIssues: ReviewIssue[],
  epicId: string,
  sessionId: string,
): Promise<string> {
  const {
    claimReviewFeedback,
    markReviewFeedbackStarted,
    completeReviewFeedback,
    releaseReviewFeedbackClaim,
    createEvent,
    appendEvent,
  } = await import("swarm-mail");
  const operationId = args.operation_id;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        args.project_key,
        args.task_id,
        args.worker_id,
        args.status,
        args.summary ?? null,
        parsedIssues,
      ]),
    )
    .digest("hex");

  let claim: Awaited<ReturnType<typeof claimReviewFeedback>>;
  try {
    claim = await claimReviewFeedback({
      operationId,
      projectKey: args.project_key,
      taskId: args.task_id,
      workerId: args.worker_id,
      requestHash,
      status: args.status,
      hostInstanceId: HOST_INSTANCE_ID,
      hostname: hostname(),
      pid: process.pid,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "OperationIdConflictError") {
      return JSON.stringify(
        {
          success: false,
          operation_id: operationId,
          error: `operation_id ${operationId} was already used for a different review request`,
        },
        null,
        2,
      );
    }
    throw error;
  }

  if (claim.kind === "done") {
    return JSON.stringify({ ...claim.result, duplicate: true }, null, 2);
  }
  if (claim.kind === "busy") {
    return JSON.stringify(
      {
        success: false,
        busy: true,
        operation_id: operationId,
        task_id: args.task_id,
        attempt: claim.attempt,
        error: "Review feedback for this operation_id is already in progress",
      },
      null,
      2,
    );
  }

  const { claimToken, attempt } = claim;
  await markReviewFeedbackStarted(operationId, claimToken);

  try {
  const approved = args.status === "approved";
  const remaining = approved ? MAX_REVIEW_ATTEMPTS : MAX_REVIEW_ATTEMPTS - attempt;

  try {
    captureCoordinatorEvent({
      session_id: sessionId,
      epic_id: epicId,
      timestamp: new Date().toISOString(),
      event_type: "DECISION",
      decision_type: "review_completed",
      payload: approved
        ? { task_id: args.task_id, status: "approved", retry_count: 0 }
        : {
            task_id: args.task_id,
            status: "needs_changes",
            retry_count: attempt,
            remaining_attempts: remaining,
            issues_count: parsedIssues.length,
          },
    });
  } catch (error) {
    console.warn("[swarm_review_feedback] Failed to capture review_completed:", error);
  }

  await traceReviewDecision({
    projectKey: args.project_key,
    agentName: "coordinator",
    epicId,
    beadId: args.task_id,
    workerId: args.worker_id,
    status: args.status,
    summary: args.summary,
    issues: approved ? undefined : parsedIssues,
    attemptNumber: attempt,
    remainingAttempts: remaining,
    rationale:
      args.summary ||
      (approved ? "Review approved" : `Review rejected: ${parsedIssues.length} issue(s) found`),
    operationId,
  });

  await appendEvent(
    createEvent("review_completed", {
      project_key: args.project_key,
      epic_id: epicId,
      bead_id: args.task_id,
      status: approved ? "approved" : remaining <= 0 ? "blocked" : "needs_changes",
      attempt,
      operation_id: operationId,
    }),
    args.project_key,
  );

  let result: Record<string, unknown> & {
    success: true;
    status: "approved" | "needs_changes";
    task_id: string;
  };
  if (approved) {
    await sendSwarmMessage({
      projectPath: args.project_key,
      fromAgent: "coordinator",
      toAgents: [args.worker_id],
      subject: `APPROVED: ${args.task_id}`,
      body: `## Review Approved ✓

${args.summary || "Your work has been approved."}

You may now complete the task with \`swarm_complete\`.`,
      threadId: epicId,
      importance: "normal",
      operationId: `${operationId}:worker-message`,
    });
    result = {
      success: true,
      status: "approved",
      task_id: args.task_id,
      attempt,
      message: "Review approved. Worker can now complete the task.",
    };
  } else if (remaining <= 0) {
    const adapter = await getHiveAdapterSafe(args.project_key);
    if (adapter) {
      try {
        await adapter.changeCellStatus(args.project_key, args.task_id, "blocked");
      } catch {
        // Continue even if status update fails
      }
    }
    result = {
      success: true,
      status: "needs_changes",
      task_failed: true,
      task_id: args.task_id,
      attempt,
      remaining_attempts: 0,
      message: `Task failed after ${MAX_REVIEW_ATTEMPTS} review attempts`,
    };
  } else {
    result = {
      success: true,
      status: "needs_changes",
      task_id: args.task_id,
      attempt,
      remaining_attempts: remaining,
      issues: parsedIssues,
      message: `Review feedback ready. ${remaining} attempt(s) remaining.`,
      retry_context: {
        task_id: args.task_id,
        attempt,
        max_attempts: MAX_REVIEW_ATTEMPTS,
        issues: parsedIssues,
        next_action: "Use swarm_spawn_retry to spawn new worker with these issues",
      },
    };
  }

  await completeReviewFeedback(operationId, claimToken, result);
  return JSON.stringify(result, null, 2);
  } catch (error) {
    // Release the claim (state/attempt preserved) so a retry can re-claim;
    // all side effects are operation-keyed, so re-execution is safe.
    await releaseReviewFeedbackClaim(operationId, claimToken).catch(() => undefined);
    throw error;
  }
}

/**
 * Durable review gate for keyed approvals (process-independent).
 */
export async function getDurableReviewApproval(
  projectKey: string,
  taskId: string,
): Promise<boolean> {
  try {
    const { getDurableReviewFeedbackApproval } = await import("swarm-mail");
    return await getDurableReviewFeedbackApproval(projectKey, taskId);
  } catch (error) {
    console.warn("[swarm_review] durable review lookup failed:", error);
    return false;
  }
}

/**
 * Send review feedback to a worker
 *
 * Tracks review attempts and fails the task after 3 rejections.
 */
export const swarm_review_feedback = tool({
  description:
    "Send review feedback to a worker. Tracks attempts (max 3). Fails task after 3 rejections.",
  args: {
    project_key: z.string().describe("Project path"),
    task_id: z.string().describe("Subtask cell ID"),
    worker_id: z.string().describe("Worker agent name"),
    status: z.enum(["approved", "needs_changes"]).describe("Review status"),
    summary: z.string().optional().describe("Review summary"),
    issues: z
      .string()
      .optional()
      .describe("JSON array of ReviewIssue objects (for needs_changes)"),
    operation_id: z
      .string()
      .optional()
      .describe("Optional idempotency key forwarded unchanged"),
  },
  async execute(args, _ctx): Promise<string> {
    // Parse issues if provided
    let parsedIssues: ReviewIssue[] = [];
    if (args.issues) {
      try {
        parsedIssues = JSON.parse(args.issues);
      } catch {
        return JSON.stringify(
          {
            success: false,
            error: "Failed to parse issues JSON",
          },
          null,
          2
        );
      }
    }

    // Validate: needs_changes requires issues
    if (args.status === "needs_changes" && parsedIssues.length === 0) {
      return JSON.stringify(
        {
          success: false,
          error: "needs_changes status requires at least one issue",
        },
        null,
        2
      );
    }

    // Extract epic ID for thread
    const epicId = args.task_id.includes(".")
      ? args.task_id.split(".")[0]
      : args.task_id;

    if (args.operation_id) {
      return executeKeyedReviewFeedback(
        { ...args, operation_id: args.operation_id },
        parsedIssues,
        epicId,
        _ctx.sessionID || "unknown",
      );
    }

    if (args.status === "approved") {
      // Mark as approved and clear attempts
      markReviewApproved(args.task_id);

      // Capture review approval decision (legacy eval capture)
      try {
        captureCoordinatorEvent({
          session_id: _ctx.sessionID || "unknown",
          epic_id: epicId,
          timestamp: new Date().toISOString(),
          event_type: "DECISION",
          decision_type: "review_completed",
          payload: {
            task_id: args.task_id,
            status: "approved",
            retry_count: 0,
          },
        });
      } catch (error) {
        // Non-fatal - don't block approval if capture fails
        console.warn("[swarm_review_feedback] Failed to capture review_completed:", error);
      }

      // Capture decision trace (new context graph architecture)
      try {
        await traceReviewDecision({
          projectKey: args.project_key,
          agentName: "coordinator",
          epicId: epicId,
          beadId: args.task_id,
          workerId: args.worker_id,
          status: "approved",
          summary: args.summary,
          attemptNumber: 1,
          remainingAttempts: MAX_REVIEW_ATTEMPTS,
          rationale: args.summary || "Review approved",
        });
      } catch (error) {
        // Non-fatal - don't block approval if trace fails
        console.warn("[swarm_review_feedback] Failed to trace review_decision:", error);
      }

      // Emit ReviewCompletedEvent for lifecycle tracking
      try {
        const { createEvent, appendEvent } = await import("swarm-mail");
        const attempt = getReviewStatus(args.task_id).attempt_count || 1;
        const reviewCompletedEvent = createEvent("review_completed", {
          project_key: args.project_key,
          epic_id: epicId,
          bead_id: args.task_id,
          status: "approved",
          attempt,
        });
        await appendEvent(reviewCompletedEvent, args.project_key);
      } catch (error) {
        // Non-fatal - log and continue
        console.warn("[swarm_review_feedback] Failed to emit ReviewCompletedEvent:", error);
      }

      // Send approval message
      await sendSwarmMessage({
        projectPath: args.project_key,
        fromAgent: "coordinator",
        toAgents: [args.worker_id],
        subject: `APPROVED: ${args.task_id}`,
        body: `## Review Approved ✓

${args.summary || "Your work has been approved."}

You may now complete the task with \`swarm_complete\`.`,
        threadId: epicId,
        importance: "normal",
      });

      return JSON.stringify(
        {
          success: true,
          status: "approved",
          task_id: args.task_id,
          message: "Review approved. Worker can now complete the task.",
        },
        null,
        2
      );
    }

    // Handle needs_changes
    const attemptNumber = incrementAttempt(args.task_id);
    const remaining = MAX_REVIEW_ATTEMPTS - attemptNumber;

    // Capture review rejection decision (legacy eval capture)
    try {
      captureCoordinatorEvent({
        session_id: _ctx.sessionID || "unknown",
        epic_id: epicId,
        timestamp: new Date().toISOString(),
        event_type: "DECISION",
        decision_type: "review_completed",
        payload: {
          task_id: args.task_id,
          status: "needs_changes",
          retry_count: attemptNumber,
          remaining_attempts: remaining,
          issues_count: parsedIssues.length,
        },
      });
    } catch (error) {
      // Non-fatal - don't block feedback if capture fails
      console.warn("[swarm_review_feedback] Failed to capture review_completed:", error);
    }

    // Capture decision trace (new context graph architecture)
    try {
      await traceReviewDecision({
        projectKey: args.project_key,
        agentName: "coordinator",
        epicId: epicId,
        beadId: args.task_id,
        workerId: args.worker_id,
        status: "needs_changes",
        summary: args.summary,
        issues: parsedIssues,
        attemptNumber,
        remainingAttempts: remaining,
        rationale: args.summary || `Review rejected: ${parsedIssues.length} issue(s) found`,
      });
    } catch (error) {
      // Non-fatal - don't block feedback if trace fails
      console.warn("[swarm_review_feedback] Failed to trace review_decision:", error);
    }

    // Emit ReviewCompletedEvent for lifecycle tracking
    try {
      const { createEvent, appendEvent } = await import("swarm-mail");
      const status = remaining <= 0 ? "blocked" : "needs_changes";
      const reviewCompletedEvent = createEvent("review_completed", {
        project_key: args.project_key,
        epic_id: epicId,
        bead_id: args.task_id,
        status,
        attempt: attemptNumber,
      });
      await appendEvent(reviewCompletedEvent, args.project_key);
    } catch (error) {
      // Non-fatal - log and continue
      console.warn("[swarm_review_feedback] Failed to emit ReviewCompletedEvent:", error);
    }

    // Check if task should fail
    if (remaining <= 0) {
      // Mark task as blocked using HiveAdapter
      const adapter = await getHiveAdapterSafe(args.project_key);
      if (adapter) {
        try {
          await adapter.changeCellStatus(args.project_key, args.task_id, "blocked");
        } catch {
          // Continue even if status update fails
        }
      }

      // NO sendSwarmMessage - worker is dead, can't read it
      // Coordinator handles retry or escalation

      return JSON.stringify(
        {
          success: true,
          status: "needs_changes",
          task_failed: true,
          task_id: args.task_id,
          attempt: attemptNumber,
          remaining_attempts: 0,
          message: `Task failed after ${MAX_REVIEW_ATTEMPTS} review attempts`,
        },
        null,
        2
      );
    }

    // NO sendSwarmMessage for needs_changes - worker is dead
    // Instead, return retry_context for coordinator to use with swarm_spawn_retry

    return JSON.stringify(
      {
        success: true,
        status: "needs_changes",
        task_id: args.task_id,
        attempt: attemptNumber,
        remaining_attempts: remaining,
        issues: parsedIssues,
        message: `Review feedback ready. ${remaining} attempt(s) remaining.`,
        retry_context: {
          task_id: args.task_id,
          attempt: attemptNumber,
          max_attempts: MAX_REVIEW_ATTEMPTS,
          issues: parsedIssues,
          next_action: "Use swarm_spawn_retry to spawn new worker with these issues",
        },
      },
      null,
      2
    );
  },
});

// ============================================================================
// Review Gate for swarm_complete
// ============================================================================

/**
 * Review status for a task
 */
interface TaskReviewStatus {
  reviewed: boolean;
  approved: boolean;
  attempt_count: number;
  remaining_attempts: number;
}

/**
 * In-memory tracking of review status per task
 */
const reviewStatus = new Map<string, { approved: boolean; timestamp: number }>();

/**
 * Mark a task as reviewed and approved
 */
export function markReviewApproved(taskId: string): void {
  reviewStatus.set(taskId, { approved: true, timestamp: Date.now() });
  clearAttempts(taskId);
}

/**
 * Check if a task has been approved
 */
export function isReviewApproved(taskId: string): boolean {
  const status = reviewStatus.get(taskId);
  return status?.approved ?? false;
}

/**
 * Get review status for a task
 */
export function getReviewStatus(taskId: string): TaskReviewStatus {
  const status = reviewStatus.get(taskId);
  return {
    reviewed: status !== undefined,
    approved: status?.approved ?? false,
    attempt_count: getAttemptCount(taskId),
    remaining_attempts: getRemainingAttempts(taskId),
  };
}

/**
 * Clear review status (for testing or reset)
 */
export function clearReviewStatus(taskId: string): void {
  reviewStatus.delete(taskId);
  clearAttempts(taskId);
}

/**
 * Mark a task as reviewed but not approved (for testing)
 */
export function markReviewRejected(taskId: string): void {
  reviewStatus.set(taskId, { approved: false, timestamp: Date.now() });
}

// ============================================================================
// Exports
// ============================================================================

export const swarm_revoke_attempts = tool({
  description: "Revoke review attempts for a task (reset attempt counter). Use after partial success or to allow re-review.",
  args: {
    task_id: tool.schema.string().describe("Task ID to reset attempts for"),
  },
  async execute(args) {
    clearAttempts(args.task_id);
    return JSON.stringify({ success: true, task_id: args.task_id, message: "Attempts revoked" }, null, 2);
  },
});

export const swarm_reset = tool({
  description: "Reset swarm mission state: clear review attempts and in-memory attempt tracking. Use to recover from blocked missions.",
  args: {},
  async execute() {
    reviewAttempts.clear();
    return JSON.stringify({ success: true, message: "Swarm attempt state reset" }, null, 2);
  },
});

export const reviewTools = {
  swarm_review,
  swarm_review_feedback,
  swarm_revoke_attempts,
  swarm_reset,
};
