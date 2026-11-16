/**
 * Live, read-only contract test against the installed `swarm` CLI (Task 8).
 *
 * Gated: it only runs when `SWARMX_LIVE_CONTRACT=1` (otherwise every case is
 * skipped, so the default unit suite stays hermetic). Every invocation is
 * read-only — `--version`, `tool --list` and `tool hive_ready --json '{}'` —
 * so it is safe to run on a workstation and never mutates Hive state.
 *
 * Expected backend: swarm 0.63.2 exposing 117 tools, including the 9
 * `semantic-memory_*` tools and every active/alias `backendName` declared by
 * the catalogue.
 */
import { describe, expect, test } from "bun:test";

import { getCompatibilityMatrix } from "../src/catalog";
import { listTools, runTool, version } from "../src/cli";

const LIVE = process.env.SWARMX_LIVE_CONTRACT === "1";
const TIMEOUT_MS = 60_000;

const EXPECTED_SWARM_VERSION = "0.63.2";
const EXPECTED_TOOL_COUNT = 117;
const EXPECTED_SEMANTIC_MEMORY_TOOLS = 9;

describe("swarm CLI live contract (read-only)", () => {
  test.skipIf(!LIVE)(
    "reports the pinned swarm version",
    async () => {
      expect(await version()).toBe(EXPECTED_SWARM_VERSION);
    },
    TIMEOUT_MS,
  );

  test.skipIf(!LIVE)(
    "lists 117 tools including the semantic-memory family",
    async () => {
      const tools = await listTools();

      expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
      expect(new Set(tools).size).toBe(EXPECTED_TOOL_COUNT);
      expect(tools.filter((name) => name.startsWith("semantic-memory_"))).toHaveLength(
        EXPECTED_SEMANTIC_MEMORY_TOOLS,
      );
    },
    TIMEOUT_MS,
  );

  test.skipIf(!LIVE)(
    "exposes every active and alias backendName from the catalogue",
    async () => {
      const tools = new Set(await listTools());
      const expected = getCompatibilityMatrix()
        .filter((row) => row.kind === "backend" && row.status !== "deprecated")
        .map((row) => row.backendName)
        .filter((name): name is string => name !== undefined);

      expect(expected.length).toBeGreaterThan(0);
      const missing = expected.filter((name) => !tools.has(name));
      expect(missing).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test.skipIf(!LIVE)(
    "runs a read-only backend tool against the real CLI",
    async () => {
      const payload = await runTool("hive_ready", {});

      expect(payload).toBeDefined();
      expect(payload).not.toBeNull();
    },
    TIMEOUT_MS,
  );
});
