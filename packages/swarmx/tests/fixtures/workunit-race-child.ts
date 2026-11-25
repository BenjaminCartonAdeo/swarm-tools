import { createLibSQLAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../../src/workunit/schema.js";
import {
  beginMissionClose,
  finishMissionClose,
  reserveWorkUnit,
  transitionWorkUnit,
} from "../../src/workunit/store.js";

type Scenario = "same-cell" | "last-budget" | "same-fence" | "mission-close";

interface ChildResult {
  won: boolean;
  unitId?: string;
  error?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

async function waitForStart(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Parent did not open the race start gate within 10s");
}

async function runOperation(db: Awaited<ReturnType<typeof createLibSQLAdapter>>, scenario: Scenario, participant: string): Promise<ChildResult> {
  if (scenario === "same-fence") {
    try {
      const unit = await transitionWorkUnit(db, {
        unitId: "unit-race",
        expectedState: "RESERVED",
        unitFence: 1,
        nextState: "BOUND",
        patch: { kind: "bind", workerSession: `worker-${participant}`, workerAgent: `agent-${participant}` },
      });
      return { won: true, unitId: unit.id };
    } catch (error) {
      return { won: false, error: errorName(error) };
    }
  }

  if (scenario === "mission-close" && participant === "close") {
    try {
      const closing = await beginMissionClose(db, {
        missionPk: "mission-pk-mission",
        ownerSessionId: "session",
        expectedFence: 1,
        intent: "finish",
      });
      const terminal = await finishMissionClose(db, {
        missionPk: "mission-pk-mission",
        ownerSessionId: "session",
        expectedFence: Number(closing.fence),
      });
      return { won: true };
    } catch (error) {
      return { won: false, error: errorName(error) };
    }
  }

  try {
    const unit = await reserveWorkUnit(db, {
      project: "p",
      missionId: "mission",
      sessionId: "session",
      workerAgent: `agent-${participant}`,
      callId: `call-${participant}`,
      dispatchToken: `dispatch-${participant}`,
      cellId: scenario === "same-cell" ? "cell-race" : `cell-${participant}`,
      budgetCharge: 2,
      idemKey: `idem-${participant}`,
      attemptNo: 1,
    });
    return { won: true, unitId: unit.id };
  } catch (error) {
    return { won: false, error: errorName(error) };
  }
}

async function main(): Promise<void> {
  const dbPath = requiredEnv("SWARM_DB_PATH");
  const scenario = requiredEnv("SWARM_RACE_SCENARIO") as Scenario;
  const participant = requiredEnv("SWARM_RACE_PARTICIPANT");
  const readyPath = requiredEnv("SWARM_RACE_READY_PATH");
  const startPath = requiredEnv("SWARM_RACE_START_PATH");
  const db = await createLibSQLAdapter({ url: `file:${dbPath}` });

  try {
    await ensureWorkUnitSchema(db);
    await Bun.write(readyPath, "ready\n");
    await waitForStart(startPath);
    const result = await runOperation(db, scenario, participant);
    console.log(JSON.stringify(result));
  } finally {
    await db.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
