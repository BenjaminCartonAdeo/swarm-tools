import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import {
  beginMissionClose,
  finishMissionClose,
  getMissionBudgetUsed,
  getMissionByPk,
  getWorkUnit,
  transitionWorkUnit,
} from "../src/workunit/store.js";

interface ChildResult {
  won: boolean;
  unitId?: string;
  error?: string;
}

interface RaceContext {
  db: DatabaseAdapter;
  results: ChildResult[];
}

type RaceScenario = "same-cell" | "last-budget" | "same-fence" | "mission-close";

const liveStates = "'DONE', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED', 'ABANDONED', 'REVOKED', 'FAILED'";
const terminalMissionStates = "'FINISHED', 'CANCELLED', 'ABANDONED'";
const childFixture = join(import.meta.dir, "fixtures", "workunit-race-child.ts");
const temporaryRoot = "/tmp/opencode";
const missionPk = "mission-pk-mission";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReadyMarkers(
  paths: string[],
  children: Bun.Subprocess[],
  outputs: Promise<{ stdout: string; stderr: string }>[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map((path) => Bun.file(path).exists()))).every(Boolean)) return;
    const exitedIndex = children.findIndex((child) => child.exitCode !== null);
    if (exitedIndex !== -1) {
      const output = await outputs[exitedIndex]!;
      throw new Error(`Race child exited before ready (code ${children[exitedIndex]!.exitCode}): ${output.stderr.trim()}`);
    }
    await delay(20);
  }
  const statuses = children.map((child) => child.exitCode === null ? "running" : `exited ${child.exitCode}`).join(", ");
  throw new Error(`Race children did not become ready within ${timeoutMs}ms (${statuses})`);
}

async function withProcesses(
  scenario: RaceScenario,
  seed: (db: DatabaseAdapter) => Promise<void>,
  verify: (context: RaceContext) => Promise<void>,
): Promise<void> {
  await mkdir(temporaryRoot, { recursive: true });
  const tempDir = await mkdtemp(join(temporaryRoot, "swarmx-workunit-race-"));
  const dbPath = join(tempDir, "swarm.db");
  const startPath = join(tempDir, "start");
  const childIds = scenario === "mission-close" ? ["close", "reserve"] : ["a", "b"];
  const children: Bun.Subprocess[] = [];
  const exits: Promise<number>[] = [];
  const outputPromises: Promise<{ stdout: string; stderr: string }>[] = [];
  let inspectDb: DatabaseAdapter | undefined;

  try {
    const seedDb = await createLibSQLAdapter({ url: `file:${dbPath}` });
    try {
      await ensureWorkUnitSchema(seedDb);
      await seed(seedDb);
    } finally {
      await seedDb.close?.();
    }

    const readyPaths = childIds.map((id) => join(tempDir, `ready-${id}`));
    for (const [index, id] of childIds.entries()) {
      const child = Bun.spawn([process.execPath, childFixture], {
        env: {
          ...process.env,
          SWARM_DB_PATH: dbPath,
          SWARM_RACE_SCENARIO: scenario,
          SWARM_RACE_PARTICIPANT: id,
          SWARM_RACE_READY_PATH: join(tempDir, `ready-${id}`),
          SWARM_RACE_START_PATH: startPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      exits.push(child.exited);
      outputPromises.push(Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then(([stdout, stderr]) => ({ stdout, stderr })));
      await waitForReadyMarkers([readyPaths[index]!], children, outputPromises, 20_000);
    }

    await writeFile(startPath, "start\n", { flag: "wx" });

    let exitCodes: number[];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      exitCodes = await Promise.race([
        Promise.all(exits),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Race children did not exit within 15s")), 15_000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    const outputs = await Promise.all(outputPromises);
    const results = outputs.map(({ stdout, stderr }, index): ChildResult => {
      if (exitCodes[index] !== 0) {
        throw new Error(`Race child ${childIds[index]} exited ${exitCodes[index]}: ${stderr.trim()}`);
      }
      try {
        return JSON.parse(stdout.trim()) as ChildResult;
      } catch {
        throw new Error(`Race child ${childIds[index]} did not print one JSON result. stdout=${JSON.stringify(stdout)} stderr=${stderr.trim()}`);
      }
    });

    inspectDb = await createLibSQLAdapter({ url: `file:${dbPath}` });
    await verify({ db: inspectDb, results });
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch {
          // A child can exit between checking exitCode and sending the signal.
        }
      }
    }
    await Promise.allSettled(exits);
    await Promise.allSettled(outputPromises);
    await inspectDb?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedMission(db: DatabaseAdapter, budgetLimit = 10): Promise<void> {
  await db.query(
    `INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, budget_limit, created_at, updated_at)
     VALUES (?, 'p', 'session', 'mission', 'OPEN', 1, ?, 0, 0)`,
    [missionPk, budgetLimit],
  );
}

function expectOneWinner(results: ChildResult[]): ChildResult {
  expect(results).toHaveLength(2);
  const winners = results.filter((result) => result.won);
  expect(winners).toHaveLength(1);
  expect(results.filter((result) => !result.won)).toHaveLength(1);
  return winners[0]!;
}

function field(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null || !(key in row)) return undefined;
  return Reflect.get(row, key);
}

function requiredStringField(row: unknown, key: string): string {
  const value = field(row, key);
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
  return value;
}

function requiredUnitId(result: ChildResult): string {
  if (typeof result.unitId !== "string") throw new Error("Expected winning child to return a WorkUnit id");
  return result.unitId;
}

function expectLoserError(results: ChildResult[], expected: string): void {
  const loser = results.find((result) => !result.won);
  if (loser?.error === undefined) throw new Error(`Expected losing child error ${expected}`);
  expect(loser.error).toBe(expected);
}

async function liveUnitCount(db: DatabaseAdapter, missionId = missionPk): Promise<number> {
  const query = await db.query(
    `SELECT COUNT(id) AS count FROM swarmx_work_units WHERE mission_pk = ? AND state NOT IN (${liveStates})`,
    [missionId],
  );
  return Number(field(query.rows[0], "count") ?? 0);
}

describe("WorkUnit process fencing", () => {
  test("twoProcessesRaceForOneLiveCellUnit", async () => {
    await withProcesses("same-cell", (db) => seedMission(db), async ({ db, results }) => {
      const winner = expectOneWinner(results);
      expect(requiredUnitId(winner)).toMatch(/^unit:/);
      expectLoserError(results, "CellBusyError");
      expect(await liveUnitCount(db)).toBe(1);
      const liveCells = await db.query(
        `SELECT COUNT(DISTINCT cell_id) AS count FROM swarmx_work_units WHERE mission_pk = ? AND cell_id IS NOT NULL AND state NOT IN (${liveStates})`,
        [missionPk],
      );
      expect(Number(field(liveCells.rows[0], "count") ?? 0)).toBe(1);
    });
  }, 45_000);

  test("twoProcessesRaceForLastBudgetUnit", async () => {
    await withProcesses("last-budget", async (db) => {
      await seedMission(db, 3);
      await db.query(
        "UPDATE swarmx_missions SET budget_policy_json = ? WHERE id = ?",
        [JSON.stringify({ total: 3, perCellIterations: 10, workerShare: null, version: 1 }), missionPk],
      );
    }, async ({ db, results }) => {
      expectOneWinner(results);
      expectLoserError(results, "BudgetGateError");
      expect(await getMissionBudgetUsed(db, missionPk)).toBe(2);
      expect(await liveUnitCount(db)).toBe(1);
    });
  }, 45_000);

  test("twoProcessesRaceSameFence", async () => {
    await withProcesses("same-fence", async (db) => {
      await seedMission(db);
      await db.query(
        `INSERT INTO swarmx_work_units
          (id, project, mission_pk, call_id, cell_id, idem_key, attempt_no, state, fence, created_at, updated_at)
         VALUES ('unit-race', 'p', ?, 'call-seeded', 'cell-seeded', 'idem-seeded', 1, 'RESERVED', 1, 0, 0)`,
        [missionPk],
      );
    }, async ({ db, results }) => {
      const winner = expectOneWinner(results);
      expect(requiredUnitId(winner)).toBe("unit-race");
      expectLoserError(results, "FenceConflictError");
      expect(await getWorkUnit(db, "unit-race")).toMatchObject({ state: "BOUND", fence: 2 });
    });
  }, 45_000);

  test("missionCloseRacesReserve", async () => {
    await withProcesses("mission-close", (db) => seedMission(db), async ({ db, results }) => {
      const winner = expectOneWinner(results);
      expectLoserError(results, winner.unitId === undefined ? "MissionClosedError" : "MissionNotDrainedError");
      if (winner.unitId !== undefined) {
        expect(await liveUnitCount(db)).toBe(1);
      } else {
        expect((await getMissionByPk(db, missionPk))?.state).toBe("FINISHED");
      }

      let mission = await getMissionByPk(db, missionPk);
      if (mission?.state === "OPEN") {
        mission = await beginMissionClose(db, {
          missionPk,
          ownerSessionId: "session",
          expectedFence: Number(mission.fence),
          intent: "finish",
        });
      }
      if (mission?.state === "CLOSING") {
        const units = await db.query(
          `SELECT id, state, fence FROM swarmx_work_units WHERE mission_pk = ? AND state NOT IN (${liveStates})`,
          [missionPk],
        );
        for (const unit of units.rows) {
          const unitState = requiredStringField(unit, "state");
          if (unitState !== "RESERVED") throw new Error(`Unexpected live WorkUnit state during cleanup: ${unitState}`);
          await transitionWorkUnit(db, {
            unitId: requiredStringField(unit, "id"),
            expectedState: unitState,
            unitFence: Number(field(unit, "fence")),
            nextState: "CANCELLED",
            patch: { kind: "cancel", reason: "test cleanup" },
          });
        }
        await finishMissionClose(db, {
          missionPk,
          ownerSessionId: "session",
          expectedFence: Number(mission.fence),
        });
      }

      const terminalMission = await getMissionByPk(db, missionPk);
      if (terminalMission === null) throw new Error("Mission disappeared during close race verification");
      expect(["FINISHED", "CANCELLED", "ABANDONED"]).toContain(terminalMission.state);
      const terminalLiveUnits = await db.query(
        `SELECT COUNT(u.id) AS count FROM swarmx_work_units u
         JOIN swarmx_missions m ON m.id = u.mission_pk
         WHERE m.state IN (${terminalMissionStates}) AND u.state NOT IN (${liveStates})`,
      );
      expect(Number(field(terminalLiveUnits.rows[0], "count") ?? 0)).toBe(0);
      expect(await liveUnitCount(db)).toBe(0);
    });
  }, 45_000);
});
