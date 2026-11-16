import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("swarm-worker asset grants edit, shell, and swarm_complete", () => {
  const text = readFileSync(join(root, "assets/agents/swarm/swarm-worker.md"), "utf8");
  expect(text).toContain("action: edit");
  expect(text).toContain("action: shell");
  expect(text).toContain("swarm_complete");
});

test("swarm-coordinator asset denies direct implementation tools", () => {
  const text = readFileSync(join(root, "assets/agents/swarm/swarm-coordinator.md"), "utf8");
  expect(text).toContain("action: edit");
  expect(text).toContain("effect: deny");
  expect(text).toContain("action: shell");
});
