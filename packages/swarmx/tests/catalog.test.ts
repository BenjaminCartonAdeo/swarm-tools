/**
 * Contract tests for the swarmx V2 tool catalogue (Task 3).
 *
 * The catalogue is the single source of truth for the 83 exposed tools: the 81
 * V1 names (each covered exactly once) plus the new `swarm_finish`. These tests
 * pin the V1 → V2 compatibility matrix, the JSON Schema encoding and the
 * registration/router behaviour — no CLI, no host.
 */
import { describe, expect, mock, test } from "bun:test";

import {
  SWARMX_TOOL_SPECS,
  findToolSpec,
  getCompatibilityMatrix,
  listToolNames,
  registerTools,
} from "../src/catalog";
import type { ToolContextLike, ToolSpec } from "../src/types";
import { createFakeContext, type FakeToolEditor } from "./helpers";

/** The 81 tool names declared by the V1 plugin (frozen inventory). */
const V1_TOOL_NAMES = [
  "beads_link_thread",
  "cass_expand",
  "cass_health",
  "cass_index",
  "cass_search",
  "cass_stats",
  "cass_view",
  "hive_cells",
  "hive_close",
  "hive_create",
  "hive_create_epic",
  "hivemind_find",
  "hivemind_get",
  "hivemind_index",
  "hivemind_remove",
  "hivemind_stats",
  "hivemind_store",
  "hivemind_sync",
  "hivemind_validate",
  "hive_query",
  "hive_ready",
  "hive_session_end",
  "hive_session_start",
  "hive_start",
  "hive_sync",
  "hive_update",
  "skills_add_script",
  "skills_create",
  "skills_delete",
  "skills_execute",
  "skills_init",
  "skills_list",
  "skills_read",
  "skills_update",
  "skills_use",
  "structured_extract_json",
  "structured_parse_cell_tree",
  "structured_parse_decomposition",
  "structured_parse_evaluation",
  "structured_validate",
  "swarm_adversarial_review",
  "swarm_agent_audit",
  "swarm_broadcast",
  "swarm_complete",
  "swarm_complete_subtask",
  "swarm_decompose",
  "swarm_evaluation_prompt",
  "swarm_get_file_insights",
  "swarm_get_pattern_insights",
  "swarm_get_strategy_insights",
  "swarm_init",
  "swarmmail_ack",
  "swarmmail_health",
  "swarmmail_inbox",
  "swarmmail_init",
  "swarmmail_read_message",
  "swarmmail_release",
  "swarmmail_release_agent",
  "swarmmail_release_all",
  "swarmmail_reserve",
  "swarmmail_send",
  "swarm_plan_prompt",
  "swarm_progress",
  "swarm_record_outcome",
  "swarm_resolve_agent",
  "swarm_review",
  "swarm_review_feedback",
  "swarm_roster",
  "swarm_select_strategy",
  "swarm_set_agent",
  "swarm_set_budget",
  "swarm_spawn_researcher",
  "swarm_spawn_retry",
  "swarm_spawn_subtask",
  "swarm_status",
  "swarm_subtask_prompt",
  "swarm_validate_decomposition",
  "swarm_worktree_cleanup",
  "swarm_worktree_create",
  "swarm_worktree_list",
  "swarm_worktree_merge",
] as const;

/** The 117 tool names exposed by `swarm tool --list` (0.63.2, frozen). */
const CLI_TOOL_NAMES = [
  "cass_expand",
  "cass_health",
  "cass_index",
  "cass_search",
  "cass_stats",
  "cass_view",
  "contributor_lookup",
  "hive_cells",
  "hive_close",
  "hive_create",
  "hive_create_epic",
  "hive_link_thread",
  "hivemind_find",
  "hivemind_get",
  "hivemind_index",
  "hivemind_remove",
  "hivemind_stats",
  "hivemind_store",
  "hivemind_sync",
  "hivemind_validate",
  "hive_projects",
  "hive_query",
  "hive_ready",
  "hive_session_end",
  "hive_session_start",
  "hive_start",
  "hive_sync",
  "hive_update",
  "mandate_file",
  "mandate_list",
  "mandate_query",
  "mandate_stats",
  "mandate_vote",
  "queue_cancel",
  "queue_list",
  "queue_status",
  "queue_submit",
  "repo_file",
  "repo_readme",
  "repo_search",
  "repo_structure",
  "repo_tree",
  "semantic-memory_check",
  "semantic-memory_find",
  "semantic-memory_get",
  "semantic-memory_list",
  "semantic-memory_remove",
  "semantic-memory_stats",
  "semantic-memory_store",
  "semantic-memory_upsert",
  "semantic-memory_validate",
  "skills_add_script",
  "skills_create",
  "skills_delete",
  "skills_execute",
  "skills_init",
  "skills_list",
  "skills_read",
  "skills_reload",
  "skills_update",
  "skills_use",
  "structured_extract_json",
  "structured_parse_cell_tree",
  "structured_parse_decomposition",
  "structured_parse_evaluation",
  "structured_validate",
  "swarm_accumulate_error",
  "swarm_adversarial_review",
  "swarm_analytics",
  "swarm_branch",
  "swarm_broadcast",
  "swarm_checkpoint",
  "swarm_check_strikes",
  "swarm_complete",
  "swarm_decompose",
  "swarm_delegate_planning",
  "swarm_diagnose",
  "swarm_discover_tools",
  "swarm_evaluation_prompt",
  "swarm_get_error_context",
  "swarm_get_versions",
  "swarm_init",
  "swarm_insights",
  "swarm_learn",
  "swarmmail_ack",
  "swarmmail_health",
  "swarmmail_inbox",
  "swarmmail_init",
  "swarmmail_read_message",
  "swarmmail_release",
  "swarmmail_release_agent",
  "swarmmail_release_all",
  "swarmmail_reserve",
  "swarmmail_send",
  "swarm_plan_interactive",
  "swarm_plan_prompt",
  "swarm_progress",
  "swarm_query",
  "swarm_record_outcome",
  "swarm_recover",
  "swarm_research_phase",
  "swarm_resolve_error",
  "swarm_return",
  "swarm_review",
  "swarm_review_feedback",
  "swarm_select_strategy",
  "swarm_spawn_researcher",
  "swarm_spawn_retry",
  "swarm_spawn_subtask",
  "swarm_status",
  "swarm_subtask_prompt",
  "swarm_validate_decomposition",
  "swarm_verify",
  "swarm_worktree_cleanup",
  "swarm_worktree_create",
  "swarm_worktree_list",
  "swarm_worktree_merge",
] as const;

/** V1 names absent from the 0.63.2 CLI: 4 deprecated + 1 proven alias. */
const GAP_TOOL_NAMES = [
  "beads_link_thread",
  "swarm_complete_subtask",
  "swarm_get_file_insights",
  "swarm_get_pattern_insights",
  "swarm_get_strategy_insights",
] as const;

/**
 * Local (non-CLI) routing tools: 6 V1 dispatch tools (including
 * `swarm_subtask_prompt`, served in-process on purpose) + the new `swarm_finish`.
 * `swarm_subtask_prompt` stays in `CLI_TOOL_NAMES`: that fixture documents CLI
 * membership, not swarmx routing.
 */
const LOCAL_TOOL_NAMES = [
  "swarm_agent_audit",
  "swarm_finish",
  "swarm_reset",
  "swarm_repo_inventory",
  "swarm_resolve_agent",
  "swarm_roster",
  "swarm_set_agent",
  "swarm_set_budget",
  "swarm_subtask_prompt",
] as const;

const CLI_NAME_SET = new Set<string>(CLI_TOOL_NAMES);
const EXPECTED_COUNT = V1_TOOL_NAMES.length + 3; // 81 + swarm_finish + swarm_reset
const CALL_CONTEXT = {
  sessionID: "ses-catalog",
  agent: "build",
  messageID: "msg-catalog",
  id: "call-catalog",
} as const;

function countBySpecs(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const spec of SWARMX_TOOL_SPECS) {
    counts.set(spec.name, (counts.get(spec.name) ?? 0) + 1);
  }
  return counts;
}

function schemaProperties(spec: ToolSpec): Record<string, unknown> {
  const properties = spec.inputSchema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error(`${spec.name}: inputSchema.properties must be an object`);
  }
  return properties as Record<string, unknown>;
}

describe("catalogue coverage", () => {
  test("84 distinct tool names, all non-empty", () => {
    expect(SWARMX_TOOL_SPECS).toHaveLength(EXPECTED_COUNT);
    expect(findToolSpec("swarm_finish")).toBeDefined();

    const counts = countBySpecs();
    expect(counts.size).toBe(EXPECTED_COUNT);
    for (const [name, count] of counts) {
      expect(count).toBe(1);
    }

    for (const spec of SWARMX_TOOL_SPECS) {
      expect(typeof spec.name).toBe("string");
      expect(spec.name.trim().length).toBeGreaterThan(0);
      expect(spec.name).not.toContain("undefined");
      expect(typeof spec.description).toBe("string");
      expect(spec.description.trim().length).toBeGreaterThan(0);
    }

    expect(listToolNames()).toHaveLength(EXPECTED_COUNT);
    expect([...listToolNames()]).toEqual([...listToolNames()].sort());
  });

  test("the 81 V1 names are covered exactly once plus swarm_finish + swarm_reset", () => {
    const counts = countBySpecs();
    const missing = V1_TOOL_NAMES.filter((name) => !counts.has(name));
    expect(missing).toEqual([]);

    for (const name of V1_TOOL_NAMES) {
      expect(counts.get(name)).toBe(1);
    }

    expect(SWARMX_TOOL_SPECS.filter((spec) => spec.name === "swarm_finish")).toHaveLength(1);
    expect(SWARMX_TOOL_SPECS).toHaveLength(V1_TOOL_NAMES.length + 3);
  });
});

describe("JSON Schemas", () => {
  test("every input schema is a closed object schema", () => {
    for (const spec of SWARMX_TOOL_SPECS) {
      const schema = spec.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);

      const properties = schemaProperties(spec);
      if (schema.required !== undefined) {
        expect(Array.isArray(schema.required)).toBe(true);
        const required = schema.required as unknown[];
        for (const key of required) {
          expect(typeof key).toBe("string");
          expect(Object.keys(properties)).toContain(key as string);
        }
      }
    }
  });

  test("representative schemas keep V1 properties, required and enums", () => {
    const create = findToolSpec("hive_create");
    expect(create?.inputSchema.required).toEqual(["title"]);
    const createProps = schemaProperties(create as ToolSpec);
    expect(Object.keys(createProps).sort()).toEqual(
      ["description", "parent_id", "priority", "title", "type"].sort(),
    );
    expect((createProps.type as { enum?: unknown }).enum).toEqual([
      "bug",
      "feature",
      "task",
      "epic",
      "chore",
    ]);

    const status = findToolSpec("swarm_progress");
    expect(status?.inputSchema.required).toEqual([
      "project_key",
      "agent_name",
      "bead_id",
      "status",
    ]);

    const ready = findToolSpec("hive_ready");
    expect(schemaProperties(ready as ToolSpec)).toEqual({});
  });

  test("swarm_review requires a non-empty path list for scoped diff generation", () => {
    const review = findToolSpec("swarm_review");
    expect(review).toBeDefined();
    expect(review?.inputSchema.required).toContain("files_touched");
    expect(schemaProperties(review as ToolSpec).files_touched).toMatchObject({
      type: "array",
      minItems: 1,
    });
  });

  test("swarm_complete requires its verification and review inputs", () => {
    const complete = findToolSpec("swarm_complete");
    expect(complete).toBeDefined();
    expect(complete?.inputSchema.required).not.toContain("start_time");
    expect(complete?.inputSchema.required).toContain("files_touched");
    expect(schemaProperties(complete as ToolSpec).start_time).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemaProperties(complete as ToolSpec).files_touched).toMatchObject({
      type: "array",
      minItems: 1,
    });
    expect(schemaProperties(complete as ToolSpec).summary).toMatchObject({
      type: "string",
      minLength: 1,
    });
  });
});

describe("compatibility matrix", () => {
  test("every active backend and alias points at a real 0.63.2 CLI tool", () => {
    for (const spec of SWARMX_TOOL_SPECS) {
      if (spec.kind !== "backend" || spec.status === "deprecated") continue;
      expect(spec.backendName).toBeDefined();
      expect(CLI_NAME_SET.has(spec.backendName as string)).toBe(true);
    }
  });

  test("the five V1→CLI gaps are deprecated or a proven alias, never active", () => {
    for (const name of GAP_TOOL_NAMES) {
      const spec = findToolSpec(name);
      expect(spec).toBeDefined();
      expect(spec?.status === "deprecated" || spec?.status === "alias").toBe(true);
      expect(spec?.status).not.toBe("active");
      if (spec?.status === "deprecated") {
        const reason = spec.deprecatedReason ?? "";
        expect(reason.trim().length).toBeGreaterThan(0);
        // Actionable = cause + a replacement tool that actually exists.
        const replacement = /(?:semantic-memory_|swarm_)[a-z0-9_]+/.exec(reason);
        expect(replacement).not.toBeNull();
        const target = replacement?.[0] ?? "";
        const exists =
          CLI_NAME_SET.has(target) ||
          SWARMX_TOOL_SPECS.some((candidate) => candidate.name === target && candidate.status === "active");
        expect(exists).toBe(true);
      }
    }

    const link = findToolSpec("beads_link_thread");
    expect(link?.status).toBe("alias");
    expect(link?.backendName).toBe("hive_link_thread");
  });

  test("the eight local tools are local, active and carry no backendName", () => {
    for (const name of LOCAL_TOOL_NAMES) {
      const spec = findToolSpec(name);
      expect(spec).toBeDefined();
      expect(spec?.kind).toBe("local");
      expect(spec?.status).toBe("active");
      expect(spec?.backendName).toBeUndefined();
    }

    const locals = SWARMX_TOOL_SPECS.filter((spec) => spec.kind === "local");
    expect(locals).toHaveLength(LOCAL_TOOL_NAMES.length);
    expect(locals).toHaveLength(9);
  });

  test("matrix exposes kind, backendName and reason for every spec", () => {
    const matrix = getCompatibilityMatrix();
    expect(matrix).toHaveLength(EXPECTED_COUNT);
    const byName = new Map(matrix.map((row) => [row.name, row]));
    expect(byName.size).toBe(EXPECTED_COUNT);

    expect(byName.get("hive_ready")).toEqual({
      name: "hive_ready",
      kind: "backend",
      backendName: "hive_ready",
      status: "active",
    });
    expect(byName.get("swarm_get_file_insights")?.status).toBe("deprecated");
    expect(byName.get("swarm_get_file_insights")?.reason).toBeTruthy();
    expect(byName.get("swarm_roster")?.kind).toBe("local");
    expect(byName.get("swarm_subtask_prompt")).toEqual({
      name: "swarm_subtask_prompt",
      kind: "local",
      status: "active",
    });
  });

  test("distribution is exactly 70 backend active, 1 alias, 4 deprecated, 9 local (84)", () => {
    const activeBackend = SWARMX_TOOL_SPECS.filter(
      (spec) => spec.kind === "backend" && spec.status === "active",
    );
    const deprecated = SWARMX_TOOL_SPECS.filter((spec) => spec.status === "deprecated");
    const aliases = SWARMX_TOOL_SPECS.filter((spec) => spec.status === "alias");
    const locals = SWARMX_TOOL_SPECS.filter((spec) => spec.kind === "local");

    expect(activeBackend).toHaveLength(70);
    expect(aliases).toHaveLength(1);
    expect(deprecated).toHaveLength(4);
    expect(locals).toHaveLength(9);
    expect(activeBackend.length + aliases.length + deprecated.length + locals.length).toBe(84);
    expect(SWARMX_TOOL_SPECS).toHaveLength(84);
  });
});

describe("registerTools", () => {
  /**
   * The Task 1 fake editor keys tools by `id` (an artefact of the fake), while
   * the real V2 editor derives/assigns the id itself. Bridge here so production
   * `registerTools` can stay on the real `{ name, description, input, execute }`
   * shape.
   */
  function nameKeyedEditor(ctx: ReturnType<typeof createFakeContext>): FakeToolEditor {
    const raw = ctx.createEditor();
    return { ...raw, add: (tool) => raw.add({ ...tool, id: tool.name }) };
  }

  async function registerWithFakeRuntime(options: { readonly includeRoster?: boolean } = {}): Promise<{
    editor: FakeToolEditor;
    runTool: ReturnType<typeof mock>;
    ctx: ReturnType<typeof createFakeContext>;
  }> {
    const ctx = createFakeContext();
    const runTool = mock((name: string, args: Record<string, unknown>) =>
      Promise.resolve({ echoed: name, args }),
    );

    await registerTools(ctx as unknown as ToolContextLike, {
      runTool,
      ...(options.includeRoster === true ? { listAgents: () => ctx.agent.list() } : {}),
    });

    const transform = ctx.captures.toolTransforms[0];
    expect(transform).toBeDefined();
    const editor = nameKeyedEditor(ctx);
    transform(editor);
    return { editor, runTool, ctx };
  }

  /**
   * V2 refuses a result carrying `output` when no output schema is declared
   * (`Tool result declared output without an output schema`). Every swarmx
   * handler returns `{ output }`, so the declaration is mandatory — without it
   * the whole 83-tool surface is unusable from Code Mode.
   */
  test("every registration declares a permissive output schema", async () => {
    const { editor } = await registerWithFakeRuntime();

    for (const tool of editor.list()) {
      const schema = tool.output as
        | {
            "~standard": {
              validate: (value: unknown) => { value: unknown };
              jsonSchema: { output: (options: unknown) => unknown };
            };
          }
        | undefined;

      expect(schema?.["~standard"]).toBeDefined();
      expect(schema?.["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toEqual({});
      // Heterogeneous handler results: CLI strings, local objects, void operations.
      for (const value of ["cli-output", { ok: true }, undefined]) {
        expect(schema?.["~standard"].validate(value)).toEqual({ value });
      }
    }
  });

  test("registers all 83 tools synchronously and replay stays idempotent", async () => {
    const { editor, ctx } = await registerWithFakeRuntime();
    expect(editor.list()).toHaveLength(EXPECTED_COUNT);

    const transform = ctx.captures.toolTransforms[0];
    transform(editor);
    expect(editor.list()).toHaveLength(EXPECTED_COUNT);

    expect(editor.get("swarm_finish")).toBeDefined();
    expect(editor.get("hive_ready")).toBeDefined();
  });

  test("a backend active tool forwards backendName and args to the runtime", async () => {
    const { editor, runTool } = await registerWithFakeRuntime();
    const tool = editor.get("hive_ready");
    expect(tool).toBeDefined();

    const args = {};
    const result = await tool?.execute(args, CALL_CONTEXT);

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith("hive_ready", args, {
      env: { OPENCODE_SESSION_ID: CALL_CONTEXT.sessionID },
    });
    expect(result?.output).toEqual({ echoed: "hive_ready", args });
  });

  test("an alias forwards its target backend name", async () => {
    const { editor, runTool } = await registerWithFakeRuntime();
    const tool = editor.get("beads_link_thread");
    expect(tool).toBeDefined();

    const args = { bead_id: "cell-1", thread_id: "thread-1" };
    await tool?.execute(args, CALL_CONTEXT);

    expect(runTool).toHaveBeenCalledWith("hive_link_thread", args, {
      env: { OPENCODE_SESSION_ID: CALL_CONTEXT.sessionID },
    });
  });

  test("a deprecated tool rejects with unsupported_tool:<name> and its alternative", async () => {
    const { editor, runTool } = await registerWithFakeRuntime();
    const tool = editor.get("swarm_get_file_insights");
    expect(tool).toBeDefined();

    const failure = tool?.execute({ files: ["a.ts"] }, CALL_CONTEXT);
    await expect(failure as Promise<unknown>).rejects.toThrow(
      /unsupported_tool:swarm_get_file_insights/,
    );
    await expect(failure as Promise<unknown>).rejects.toThrow(/swarm_insights/);
    expect(runTool).not.toHaveBeenCalled();
  });

  test("a local tool never fakes success while Tasks 4/5 are pending", async () => {
    const { editor, runTool } = await registerWithFakeRuntime();
    const tool = editor.get("swarm_roster");
    expect(tool).toBeDefined();

    await expect(
      tool?.execute(
        {},
        CALL_CONTEXT,
      ) as Promise<unknown>,
    ).rejects.toThrow(/swarm_roster/);
    expect(runTool).not.toHaveBeenCalled();
  });
});
