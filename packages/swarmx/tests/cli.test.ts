/**
 * Contract tests for the `swarm` CLI adapter (`../cli.ts`).
 *
 * No real `swarm` binary is invoked: every test builds a throwaway executable
 * shell script in `os.tmpdir()` and passes it through `RunToolOptions.binary`.
 * Fixtures are removed after each test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CliError,
  createSwarmCliRunner,
  listTools,
  redact,
  runTool,
  version,
  type CliErrorCode,
} from "../src/cli";

const fixtureDirs: string[] = [];

/** Writes an executable `#!/bin/sh` script and returns its absolute path. */
function fakeBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmx-cli-"));
  fixtureDirs.push(dir);
  const file = join(dir, "swarm");
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Awaits a rejecting promise, asserts it is a CliError with `code`. */
async function expectCliError(promise: Promise<unknown>, code: CliErrorCode): Promise<CliError> {
  let caught: unknown;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      caught = error;
    },
  );

  expect(caught).toBeInstanceOf(CliError);
  const error = caught as CliError;
  expect(error.code).toBe(code);
  return error;
}

describe("runTool", () => {
  test("returns the parsed JSON payload for a bare object", async () => {
    const binary = fakeBinary(`printf '%s' '{"a":1,"b":[true,null]}'`);

    await expect(runTool("hive_ready", {}, { binary })).resolves.toEqual({
      a: 1,
      b: [true, null],
    });
  });

  test("forwards arguments as the fourth CLI argument (--json payload)", async () => {
    const binary = fakeBinary(`printf '%s' "$4"`);

    await expect(runTool("hive_create", { title: "Fix bug", priority: 2 }, { binary })).resolves.toEqual({
      title: "Fix bug",
      priority: 2,
    });
  });

  test("ignores banner noise before and after the JSON, including braces inside strings", async () => {
    const binary = fakeBinary(
      [
        `printf '%s\\n' 'SWARM banner v0.63.2'`,
        `printf '%s\\n' 'Available tools: (1 total)'`,
        `printf '%s\\n' '{"msg":"a } b { c","n":2}'`,
        `printf '%s\\n' 'trailing noise [not json'`,
      ].join("\n"),
    );

    await expect(runTool("hive_cells", {}, { binary })).resolves.toEqual({
      msg: "a } b { c",
      n: 2,
    });
  });

  test("unwraps a unique data/result payload alongside a boolean flag", async () => {
    const binary = fakeBinary(`printf '%s' '{"ok":true,"data":{"x":1}}'`);

    await expect(runTool("hive_cells", {}, { binary })).resolves.toEqual({ x: 1 });
  });

  test("keeps the full object when unwrapping would drop other fields", async () => {
    const payload = { ok: true, result: { x: 1 }, extra: "keep-me" };
    const binary = fakeBinary(`printf '%s' '${JSON.stringify(payload)}'`);

    await expect(runTool("hive_cells", {}, { binary })).resolves.toEqual(payload);
  });

  test("rejects with CliInvalidJson when stdout carries no JSON", async () => {
    const binary = fakeBinary(`printf '%s\\n' 'command failed, try again'`);

    const error = await expectCliError(runTool("hive_cells", {}, { binary }), "CliInvalidJson");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("rejects with CliNonZero and redacts secrets from stderr", async () => {
    const binary = fakeBinary(
      [
        `printf '%s\\n' 'Authorization: Bearer sk-live-abc123' >&2`,
        `printf '%s\\n' 'api_key=ghp_deadbeef' >&2`,
        `printf '%s\\n' 'secret: super-secret-value' >&2`,
        `printf '%s\\n' 'backend exploded' >&2`,
        `exit 3`,
      ].join("\n"),
    );

    const error = await expectCliError(runTool("hive_ready", {}, { binary }), "CliNonZero");
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("3");
    expect(error.message).toContain("backend exploded");
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("sk-live-abc123");
    expect(error.message).not.toContain("ghp_deadbeef");
    expect(error.message).not.toContain("super-secret-value");
  });

  test("rejects with CliNotFound and an actionable message for a missing binary", async () => {
    const binary = join(tmpdir(), "swarmx-definitely-missing-binary");

    const error = await expectCliError(runTool("hive_ready", {}, { binary }), "CliNotFound");
    expect(error.message).toContain("SWARMX_SWARM_BIN");
    expect(error.message).toContain("0.63.2");
  });

  test("kills the child and rejects with CliTimeout past the deadline", async () => {
    const binary = fakeBinary(`exec sleep 10`);

    await expectCliError(runTool("hive_ready", {}, { binary, timeoutMs: 150 }), "CliTimeout");
  });

  test("kills the child and rejects with CliAborted when the signal aborts", async () => {
    const binary = fakeBinary(`exec sleep 10`);
    const controller = new AbortController();
    const pending = runTool("hive_ready", {}, { binary, signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 50);

    await expectCliError(pending, "CliAborted");
  });

  test("rejects with CliOutputTooLarge once stdout exceeds maxBytes", async () => {
    const binary = fakeBinary(
      [
        `i=0`,
        `while [ $i -lt 200 ]; do`,
        `  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`,
        `  i=$((i+1))`,
        `done`,
      ].join("\n"),
    );

    await expectCliError(runTool("hive_ready", {}, { binary, maxBytes: 1_000 }), "CliOutputTooLarge");
  });

  test("does not throw for a zero exit code", async () => {
    const binary = fakeBinary(`printf '%s' '{"ok":true,"data":null}'`);

    await expect(runTool("hive_ready", {}, { binary })).resolves.toBeNull();
  });
});

describe("listTools", () => {
  test("extracts, sorts and deduplicates tool names while ignoring banner and sections", async () => {
    const binary = fakeBinary(
      [
        `printf '%s\\n' '\\033[33m'`,
        `printf '%s\\n' ' ███████╗██╗    ██╗ █████╗ ██████╗ ███╗   ███╗'`,
        `printf '%s\\n' '\\033[0m'`,
        `printf '%s\\n' '  Multi-agent coordination for OpenCode v0.63.2'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' 'Available tools: (3 total)'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' '  hive:'`,
        `printf '%s\\n' '    hive_ready'`,
        `printf '%s\\n' '    hive_cells'`,
        `printf '%s\\n' '  swarm:'`,
        `printf '%s\\n' '    swarm_status'`,
        `printf '%s\\n' '    hive_ready'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' 'Usage: swarm tool <name> [--json <args>]'`,
      ].join("\n"),
    );

    await expect(listTools({ binary })).resolves.toEqual(["hive_cells", "hive_ready", "swarm_status"]);
  });

  test("keeps hyphenated namespaces (semantic-memory_*) from real swarm 0.63.2 output", async () => {
    const semanticMemoryTools = [
      "semantic-memory_check",
      "semantic-memory_find",
      "semantic-memory_get",
      "semantic-memory_list",
      "semantic-memory_remove",
      "semantic-memory_stats",
      "semantic-memory_store",
      "semantic-memory_upsert",
      "semantic-memory_validate",
    ];

    // Mirrors `swarm tool --list` (0.63.2): ANSI banner, total count, category
    // headers, indented tool names, a duplicate and trailing usage lines.
    const binary = fakeBinary(
      [
        `printf '%s\\n' '\\033[33m'`,
        `printf '%s\\n' ' ███████╗██╗    ██╗ █████╗ ██████╗ ███╗   ███╗'`,
        `printf '%s\\n' ' ██╔════╝██║    ██║██╔══██╗██╔══██╗████╗ ████║'`,
        `printf '%s\\n' '\\033[0m'`,
        `printf '%s\\n' '\\033[2m  Multi-agent coordination for OpenCode v0.63.2\\033[0m'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' '\\033[36mAvailable tools:\\033[0m (117 total)'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' '\\033[32m  cass:\\033[0m'`,
        `printf '%s\\n' '    cass_search'`,
        `printf '%s\\n' '    cass_stats'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' '\\033[32m  semantic-memory:\\033[0m'`,
        ...semanticMemoryTools.map((name) => `printf '%s\\n' '    ${name}'`),
        `printf '%s\\n' ''`,
        `printf '%s\\n' '\\033[32m  swarmmail:\\033[0m'`,
        `printf '%s\\n' '    swarmmail_inbox'`,
        `printf '%s\\n' '    semantic-memory_find'`,
        `printf '%s\\n' ''`,
        `printf '%s\\n' '\\033[2mUsage: swarm tool <name> [--json <args>]\\033[0m'`,
        `printf '%s\\n' '\\033[2mExample: swarm tool hive_ready\\033[0m'`,
        `printf '%s\\n' '\\033[2mExample: swarm tool hive_create --json <args>\\033[0m'`,
      ].join("\n"),
    );

    const tools = await listTools({ binary });

    for (const name of semanticMemoryTools) {
      expect(tools).toContain(name);
    }

    const expected = ["cass_search", "cass_stats", "semantic-memory_find", "swarmmail_inbox", ...semanticMemoryTools]
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort((left, right) => left.localeCompare(right));

    expect(tools).toEqual(expected);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toEqual([...tools].sort((left, right) => left.localeCompare(right)));

    // Banner, count, category headers and usage/example lines never leak in.
    expect(tools.some((name) => name.includes(":"))).toBe(false);
    expect(tools.some((name) => name.includes(" "))).toBe(false);
    for (const noise of ["Available tools", "Multi-agent", "Usage", "Example", "██"]) {
      expect(tools.some((name) => name.includes(noise))).toBe(false);
    }
  });
});

describe("version", () => {
  test("extracts the semantic version from the banner", async () => {
    const binary = fakeBinary(
      [`printf '%s\\n' 'Swarm CLI'`, `printf '%s\\n' '  Version: 0.63.2'`, `printf '%s\\n' '  Docs: example'`].join(
        "\n",
      ),
    );

    await expect(version({ binary })).resolves.toBe("0.63.2");
  });
});

describe("createSwarmCliRunner", () => {
  test("applies default options to every call", async () => {
    const binary = fakeBinary(`printf '%s' '{"result":{"done":true},"ok":true}'`);
    const runner = createSwarmCliRunner({ binary, timeoutMs: 2_000 });

    await expect(runner.runTool("hive_ready", {})).resolves.toEqual({ done: true });
    await expect(runner.version()).rejects.toBeInstanceOf(CliError);
  });

  test("honours the SWARMX_SWARM_BIN environment override", async () => {
    const binary = fakeBinary(`printf '%s' '{"env":true}'`);
    const previous = process.env.SWARMX_SWARM_BIN;
    process.env.SWARMX_SWARM_BIN = binary;

    try {
      await expect(runTool("hive_ready", {})).resolves.toEqual({ env: true });
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMX_SWARM_BIN;
      } else {
        process.env.SWARMX_SWARM_BIN = previous;
      }
    }
  });
});

describe("redact", () => {
  test("masks key/value pairs, bearer schemes and provider token prefixes", () => {
    const masked = redact(
      "Authorization: Bearer sk-live-abc123 api_key=ghp_deadbeef token: hunter2 password=letmein",
    );

    expect(masked).toContain("[REDACTED]");
    expect(masked).not.toContain("sk-live-abc123");
    expect(masked).not.toContain("ghp_deadbeef");
    expect(masked).not.toContain("hunter2");
    expect(masked).not.toContain("letmein");
  });
});
