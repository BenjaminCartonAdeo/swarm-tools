#!/usr/bin/env bun
/**
 * Fake backend CLI for the real-host integration test (Task 19).
 *
 * Records every invocation as one JSON line in `$SWARMX_FAKE_CLI_LOG` and
 * answers with bare JSON so assertions can prove the host returned this
 * process's output, not a stub inside the test runner.
 */
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = process.env.SWARMX_FAKE_CLI_LOG;
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({ args, cwd: process.cwd(), swarmDbPath: process.env.SWARM_DB_PATH ?? null })}\n`,
  );
}

if (args[0] === "--version") {
  process.stdout.write("0.63.2\n");
} else if (args[0] === "tool" && args[1] === "--list") {
  process.stdout.write("hive:\n  hive_ready\n");
} else if (args[0] === "tool" && typeof args[1] === "string") {
  process.stdout.write(
    `${JSON.stringify({
      fake: true,
      tool: args[1],
      marker: "fake-swarm-cli-7f3a",
      cells: [{ id: "cell-fake-1", title: "Fake ready cell" }],
    })}\n`,
  );
} else {
  process.stderr.write(`fake backend: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(2);
}
