/**
 * VIOLATION capture (Task P1.8).
 *
 * Four gate refusals must leave audit evidence in the coordinator session log,
 * in the same JSONL format the swarm plugin uses for DECISION events:
 *
 *   - missing worker protocol       (`missing_worker_protocol`)
 *   - missing `start_time`          (`missing_start_time`)
 *   - non-canonical `project_key`   (`non_canonical_project_key`)
 *   - `skip_review`/`skip_verification` (`skip_bypass_attempt`)
 *
 * The rig wires the real `createSessionEventWriter()` sink, so these tests
 * assert the file on disk, not an in-memory collector.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";

import { extractCellMarker } from "../src/dispatch";
import { createSwarmxPlugin } from "../src/index";
import { createSessionEventWriter } from "../src/session-events";
import {
  createMissionStateStore,
  setAssignment,
  setBudget,
  type MissionStorageLike,
} from "../src/state";
import type { CellMarker } from "../src/types";
import {
  createFakeContext,
  type FakeAgentInfo,
  type FakeToolInfo,
  type FakeToolBeforePayload,
} from "./helpers";

const PROJECT = "adeo";
const SESSION = "ses-violations-parent";
const WORKER_SESSION = "ses-violations-worker";
const CELL = "cell-v";
const EPIC = "epic-v";

const AGENTS: readonly FakeAgentInfo[] = [
  {
    id: "swarm/swarm-coordinator",
    name: "swarm-coordinator",
    description: "Coordinator",
    mode: "primary",
    hidden: false,
    permissions: [],
  },
  {
    id: "swarm/swarm-worker",
    name: "swarm-worker",
    description: "Worker",
    mode: "subagent",
    hidden: false,
    permissions: [],
  },
];

interface Rig {
  readonly ctx: ReturnType<typeof createFakeContext>;
  readonly tools: Map<string, FakeToolInfo>;
  readonly before: (payload: FakeToolBeforePayload) => Promise<void>;
  readonly bindWorker: (marker: CellMarker) => void;
}

/** Boots the plugin on a fake host, with the real JSONL writer as the sink. */
async function createRig(projectPath: string): Promise<Rig> {
  const ctx = createFakeContext({ agents: AGENTS, projectId: PROJECT, projectPath });
  const workerCells = new Map<string, CellMarker>();
  const workerParents = new Map<string, string | null>([[WORKER_SESSION, SESSION]]);
  const plugin = createSwarmxPlugin({
    runtime: {
      runTool: async () => ({ ok: true }),
      sessionID: () => SESSION,
      sessionEvents: createSessionEventWriter(),
      resolveWorkerCell: async (sessionID) => workerCells.get(sessionID),
      resolveWorkerParentSession: async (sessionID) => workerParents.get(sessionID),
    },
  });
  await plugin.setup(ctx as unknown as Plugin.Context);

  const transform = ctx.captures.toolTransforms[0];
  expect(transform).toBeDefined();
  const editor = ctx.createEditor();
  transform?.(editor);
  const tools = new Map(editor.list().map((tool) => [tool.name, tool]));

  const before = ctx.captures.toolHooks.get("execute.before")?.[0];
  expect(before).toBeDefined();

  return {
    ctx,
    tools,
    before: async (payload) => {
      await before?.(payload);
    },
    bindWorker: (marker) => {
      workerCells.set(WORKER_SESSION, marker);
    },
  };
}

function coordinatorContext(id: string): {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
} {
  return { sessionID: SESSION, agent: "swarm/swarm-coordinator", messageID: "msg-v", id };
}

function workerContext(id: string): {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
} {
  return { sessionID: WORKER_SESSION, agent: "swarm/swarm-worker", messageID: "msg-w", id };
}

/** Active mission + assigned cell + one dispatched attempt for `CELL`. */
async function dispatchWorker(rig: Rig): Promise<void> {
  const store = createMissionStateStore(rig.ctx.storage as unknown as MissionStorageLike, {
    projectID: PROJECT,
  });
  await setBudget(store, {
    projectID: PROJECT,
    sessionID: SESSION,
    mode: "dev",
    maxSpawns: 5,
    maxIterations: 5,
    workerShare: 1,
  });
  await setAssignment(store, PROJECT, CELL, "swarm/swarm-worker");
  const payload: FakeToolBeforePayload = {
    tool: "subagent",
    sessionID: SESSION,
    agent: "swarm/swarm-coordinator",
    messageID: "msg-dispatch",
    id: "call-dispatch",
    input: {
      agent: "swarm/swarm-worker",
      prompt: `Implement the assigned cell.\n\n<!-- swarmx:cell=${CELL}; epic=${EPIC} -->`,
    },
  };
  await rig.before(payload);
  // The gate appends the one-use dispatch token to the prompt in place.
  const prompt = (payload.input as { prompt: string }).prompt;
  rig.bindWorker(extractCellMarker({ prompt }));
}

interface ViolationRecord {
  readonly session_id: string;
  readonly epic_id: string;
  readonly timestamp: string;
  readonly event_type: string;
  readonly violation_type: string;
  readonly payload: Record<string, unknown>;
}

function readEvents(sessionID: string): ViolationRecord[] {
  const path = join(process.env.SWARM_SESSIONS_DIR ?? "", `${sessionID}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ViolationRecord);
}

function readViolations(sessionID: string): ViolationRecord[] {
  return readEvents(sessionID).filter((event) => event.event_type === "VIOLATION");
}

let projectPath: string;
let previousSessionsDir: string | undefined;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "swarmx-violations-"));
  projectPath = await realpath(root);
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "src/a.ts"), "export const a = 1;\n", "utf-8");
  previousSessionsDir = process.env.SWARM_SESSIONS_DIR;
  process.env.SWARM_SESSIONS_DIR = join(projectPath, ".sessions");
});

afterEach(async () => {
  if (previousSessionsDir === undefined) delete process.env.SWARM_SESSIONS_DIR;
  else process.env.SWARM_SESSIONS_DIR = previousSessionsDir;
  await rm(projectPath, { recursive: true, force: true });
});

describe("VIOLATION events", () => {
  test("missing worker protocol is recorded", async () => {
    const rig = await createRig(projectPath);

    const result = await rig.tools.get("swarm_subtask_prompt")?.execute(
      {
        agent_name: "swarm/swarm-worker",
        bead_id: CELL,
        epic_id: EPIC,
        subtask_title: "Wire the handler",
        subtask_description: "Add the handler.",
        files: ["src/a.ts"],
      },
      coordinatorContext("call-subtask-prompt"),
    );

    // Fail-closed behaviour is unchanged: the prompt still ships the guardrail.
    expect(result).toBeDefined();
    const violations = readViolations(SESSION);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      session_id: SESSION,
      epic_id: EPIC,
      event_type: "VIOLATION",
      violation_type: "missing_worker_protocol",
    });
    expect(violations[0]?.payload).toMatchObject({
      tool: "swarm_subtask_prompt",
      bead_id: CELL,
    });
  });

  test("missing start_time is recorded on completion", async () => {
    const rig = await createRig(projectPath);
    await dispatchWorker(rig);

    const result = await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm/swarm-worker",
        bead_id: CELL,
        summary: "Completed without a start_time.",
        files_touched: ["src/a.ts"],
      },
      workerContext("call-complete-no-start"),
    );

    // The lenient submission-time fallback still applies.
    expect((result?.output as { status?: string } | undefined)?.status).toBe("pending_review");
    const violations = readViolations(WORKER_SESSION);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      session_id: WORKER_SESSION,
      epic_id: EPIC,
      event_type: "VIOLATION",
      violation_type: "missing_start_time",
    });
    expect(violations[0]?.payload).toMatchObject({
      tool: "swarm_complete",
      bead_id: CELL,
      agent_name: "swarm/swarm-worker",
    });
  });

  test("an explicit start_time records no violation", async () => {
    const rig = await createRig(projectPath);
    await dispatchWorker(rig);

    await rig.tools.get("swarm_complete")?.execute(
      {
        project_key: projectPath,
        agent_name: "swarm/swarm-worker",
        bead_id: CELL,
        summary: "Completed with a start_time.",
        files_touched: ["src/a.ts"],
        start_time: 1,
      },
      workerContext("call-complete-with-start"),
    );

    expect(readViolations(WORKER_SESSION)).toHaveLength(0);
  });

  test("a non-canonical project_key is recorded", async () => {
    const rig = await createRig(projectPath);

    await expect(
      rig.tools.get("swarm_review")?.execute(
        {
          project_key: `${projectPath}/`,
          epic_id: EPIC,
          task_id: CELL,
          files_touched: ["src/a.ts"],
        },
        coordinatorContext("call-review-trailing-slash"),
      ),
    ).rejects.toThrow(/canonical active project root/);

    const violations = readViolations(SESSION);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      session_id: SESSION,
      event_type: "VIOLATION",
      violation_type: "non_canonical_project_key",
    });
    expect(violations[0]?.payload).toMatchObject({
      tool: "swarm_review",
      project_key: `${projectPath}/`,
    });
  });

  test("a project_key pointing outside the root is recorded", async () => {
    const rig = await createRig(projectPath);

    await expect(
      rig.tools.get("swarm_review")?.execute(
        {
          project_key: join(projectPath, "src"),
          epic_id: EPIC,
          task_id: CELL,
          files_touched: ["src/a.ts"],
        },
        coordinatorContext("call-review-outside"),
      ),
    ).rejects.toThrow(/must name the active project root/);

    expect(readViolations(SESSION).map((event) => event.violation_type)).toEqual([
      "non_canonical_project_key",
    ]);
  });

  test("a skip_review bypass is recorded and refused", async () => {
    const rig = await createRig(projectPath);

    await expect(
      rig.tools.get("swarm_complete")?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm/swarm-worker",
          bead_id: CELL,
          summary: "Trying to skip review.",
          files_touched: ["src/a.ts"],
          start_time: 1,
          skip_review: true,
        },
        workerContext("call-skip-review"),
      ),
    ).rejects.toThrow(/never allows review or verification bypasses/);

    const violations = readViolations(WORKER_SESSION);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      session_id: WORKER_SESSION,
      event_type: "VIOLATION",
      violation_type: "skip_bypass_attempt",
    });
    expect(violations[0]?.payload).toMatchObject({
      tool: "swarm_complete",
      flag: "skip_review",
      bead_id: CELL,
    });
  });

  test("a skip_verification bypass is recorded and refused", async () => {
    const rig = await createRig(projectPath);

    await expect(
      rig.tools.get("swarm_complete")?.execute(
        {
          project_key: projectPath,
          agent_name: "swarm/swarm-worker",
          bead_id: CELL,
          summary: "Trying to skip verification.",
          files_touched: ["src/a.ts"],
          start_time: 1,
          skip_verification: "yes",
        },
        workerContext("call-skip-verification"),
      ),
    ).rejects.toThrow(/never allows review or verification bypasses/);

    expect(readViolations(WORKER_SESSION).map((event) => event.violation_type)).toEqual([
      "skip_bypass_attempt",
    ]);
  });

  test("violations share the DECISION event record shape", async () => {
    const rig = await createRig(projectPath);

    await rig.tools.get("swarm_subtask_prompt")?.execute(
      {
        agent_name: "swarm/swarm-worker",
        bead_id: CELL,
        epic_id: EPIC,
        subtask_title: "Shape check",
        subtask_description: "Shape check.",
        files: ["src/a.ts"],
      },
      coordinatorContext("call-shape"),
    );

    const [violation] = readEvents(SESSION);
    expect(Object.keys(violation ?? {}).sort()).toEqual(
      ["epic_id", "event_type", "payload", "session_id", "timestamp", "violation_type"].sort(),
    );
    expect(new Date(violation?.timestamp ?? "").toISOString()).toBe(violation?.timestamp ?? "");
    expect(join(process.env.SWARM_SESSIONS_DIR ?? "", `${SESSION}.jsonl`)).toBe(
      join(projectPath, ".sessions", `${SESSION}.jsonl`),
    );
  });
});
