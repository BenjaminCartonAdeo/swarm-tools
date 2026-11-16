import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionEventWriter, emitDecision } from "../src/session-events";

const dir = mkdtempSync(join(tmpdir(), "swarmx-events-"));
const previous = process.env.SWARM_SESSIONS_DIR;
process.env.SWARM_SESSIONS_DIR = dir;

afterAll(() => {
  if (previous === undefined) delete process.env.SWARM_SESSIONS_DIR;
  else process.env.SWARM_SESSIONS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

test("emitDecision writes a DECISION event", () => {
  const sink = createSessionEventWriter();
  emitDecision(sink, {
    sessionID: "ses-1",
    epicID: "epic-1",
    decisionType: "review_approved",
    payload: { task_id: "cell-1" },
  });

  const event = JSON.parse(readFileSync(join(dir, "ses-1.jsonl"), "utf8").trim());
  expect(event.event_type).toBe("DECISION");
  expect(event.decision_type).toBe("review_approved");
  expect(event.payload.task_id).toBe("cell-1");
});
