---
name: swarm-coordination
description: Use when coordinating parallel OpenCode V2 work with swarmx, especially cell decomposition, agent assignment, subagent dispatch, research cells, or swarm review.
metadata:
  target_agents:
    - "swarm/swarm-planner"
    - "swarm/swarm-worker"
    - "swarm/swarm-researcher"
    - "swarm/swarm-coordinator"
---

# Swarm Coordination (OpenCode V2)

Use `/swarmx` as the source of truth for a swarmx mission. This skill summarizes the V2
dispatch contract and common failure modes; it does not replace the command's full workflow.

## When to Swarm

Use a swarm when work has independent cells, multiple specializations, or a useful parallel
boundary. Keep small, sequential tasks in one session. All coordination uses `swarmmail_*`;
workers reserve their own files, and the coordinator never edits implementation files.

## V2 Dispatch Contract

- The native OpenCode tool is `subagent({agent, description, prompt})`; it always runs in
  the background and has no `background` input field. Do not use the removed V1
  `Task(subagent_type=...)` call.
- `agent` is the exact V2 agent ID persisted by swarmx for the cell (in plugin storage, not
  a Hive tag), including its path prefix (for example `swarm/swarm-worker`). The `subagent` tool runs a child in the
  background; wait for its `<subagent>` result and do not poll.
- Each dispatch prompt contains exactly one marker:
  `<!-- swarmx:cell=<cellID>; epic=<epicID> -->`.
- `swarm_subtask_prompt` generates the final prompt once per dispatch attempt. Its `files`
  list must contain at least one real path; never pass `[]` or invent a path.
- `swarm_spawn_subtask` and `swarm_spawn_researcher` generate prompt content; neither starts
  a child session.
- Model selection is not swarmx's job. The official `opencode-model-router` plugin maps
  agent names to `fast`/`medium`/`heavy` tiers via `subagentTiers` in
  `.opencode/opencode-model-router.overrides.jsonc`; the active preset supplies the model.
  Unmapped agents and providers without a preset keep their selected model. The router
  registers the `fast`, `medium`, `heavy` tier agents.
- Cells may carry `tier: fast|medium|heavy`. When the matching tier agent exists in the
  roster, `swarm_resolve_agent` selects and persists it; otherwise resolution falls back to
  the normal lexical matching.
- Limits: the shell CLI filter is best-effort, not a sandbox; review covers the worker-declared
  `files_touched` list, not a complete changed-file manifest; primary agents are not tier-routed.
- Root sessions report `null` for a missing parent; root `mode: all` keeps write access, while
  root `mode: subagent` and unreadable child sessions fail closed. Specialists are `subagent`;
  orchestrators (`swarm-coordinator`, `spom-prod-triage`, `weekly-advisor`,
  `loadtest-orchestrator`, `spom-incident-responder`) stay `primary`.

Example V2 dispatch shape. The prompt below is shortened to show the envelope; the real,
verbatim `swarm_subtask_prompt` result also includes a trailing `Protocol:` section unless
the protocol already appears in the cell brief or shared context.

```json
{
  "agent": "swarm/swarm-worker",
  "description": "Add request tests",
  "prompt": "<!-- swarmx:cell=cell-42; epic=epic-17 -->\n# Subtask cell-42: Add request tests\nAgent: swarm/swarm-worker\n\nAdd tests for request timeout behavior.\n\nFiles:\n- tests/request-timeout.test.ts"
}
```

## Research and Path Discovery

The V2 dispatch gate requires an active budget, an existing cell assignment, a dispatchable
agent, and the exact cell marker. Therefore, research and path-discovery work must be explicit
cells in the Hive epic; never spawn them before the cell exists or outside the budget.

For unfamiliar APIs, experimental features, or documentation-heavy work:

1. Add a read-only research cell to the epic and assign it to `swarm/swarm-researcher`.
2. Use `swarm_spawn_researcher` to generate research content; it is not a dispatch.
3. Use the returned content in the cell brief, then call `swarm_subtask_prompt` once with a
   real anchor path, such as a package manifest or relevant source file.
4. Dispatch the final prompt using the persisted V2 agent ID. The plugin includes the
   `swarm-worker-protocol` skill once (in its original location or a trailing `Protocol:`
   section); if it is unavailable, the child must load it or stop.

If the file list is unknown, the coordinator must get paths from the user/plan or create an
assigned, budgeted path-discovery cell; it has no shell or file-inventory permission. Workers
and researchers may use `glob`/`grep` inside their assigned scope. If no real path can be
identified, stop and ask rather than inventing one or passing an empty list.

## Worker Lifecycle and Review

1. Initialize `swarmmail`, read relevant prior knowledge, and reserve assigned files before
   editing.
2. Report progress with `swarm_progress`; store reusable findings with `hivemind_store`.
3. Wait for the asynchronous `<subagent>` completion report. Call
   `swarm_review({project_key, epic_id, task_id, files_touched})` with a non-empty list of
   that cell's reported paths; for a completion submitted with `read_only: true`, pass an
   empty list and expect no diff. Compare its scoped diff to acceptance criteria, then send
   `swarm_review_feedback` (the plugin requires and consumes a one-use review receipt). If
   the diff is missing/truncated, split the path list or block and escalate—never fall back
   to shell or direct file reads.
4. For `needs_changes`, use `swarm_spawn_retry` for retry context and generate one new final
   prompt for that retry attempt. Do not retry past the mission limit; mark the cell blocked
   and escalate.
5. Workers submit completion with `swarm_complete`, providing a non-empty `files_touched`
   list (`start_time` is optional and auto-filled with the submission time). A read-only
   audit cell instead passes `read_only: true` with an empty list. After
   coordinator approval, swarmx runs the Verification
   Gate and finalizes that submission. Swarmx rejects `skip_review` and `skip_verification`
   for all callers. The coordinator audits distribution, calls `hive_sync`, stores reusable
   learnings, then calls `swarm_finish`.

## Common Failures

| Failure | Corrective action |
|---|---|
| V1 `Task` or `subagent_type` call | Use native V2 `subagent` with `agent`, `description`, `prompt` |
| Extra `background` field | Omit it; V2 subagents always run in the background |
| Prompt generator treated as a spawn | Generate a final cell prompt, then call `subagent` |
| Missing/duplicate marker | Regenerate once with `swarm_subtask_prompt`; copy its output unchanged |
| Basename used instead of V2 agent ID | Copy the canonical ID returned by `swarm_resolve_agent` |
| Empty or guessed file list | Use user/plan paths or an assigned discovery cell; otherwise stop for clarification |
| Coordinator needs file contents | Use scoped `swarm_review`; if absent, block/escalate (no shell/read fallback) |
| Research dispatched before epic/assignment | Add an assigned research cell first; count it against the spawn budget |
| Repeated polling | Wait for the child result event; escalate if the bounded wait expires |

See `references/strategies.md` and `references/coordinator-patterns.md` for decomposition
patterns. Use `/swarmx` for budgets, approvals, gate handling, retries, and mission closure.
