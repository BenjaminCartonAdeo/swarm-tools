/**
 * Regression tests for `swarm reset`.
 *
 * `reset()` lives in `packages/opencode-swarm-plugin/bin/swarm.ts` and is not
 * exported, so we exercise it the way users do: spawn the CLI with an isolated
 * `HOME` pointing at a throwaway directory. That keeps the test deterministic
 * and keeps the real `~/.config/swarm-tools/swarm.db` untouched.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "opencode-swarm-plugin", "bin", "swarm.ts");

// Prefer the pre-created sandbox dir; fall back to the platform tmpdir.
const TMP_BASE = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();

const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Create an isolated HOME and return its swarm-tools directory. */
function makeHome(): { home: string; dir: string } {
  const home = mkdtempSync(join(TMP_BASE, "swarmx-reset-"));
  created.push(home);
  const dir = join(home, ".config", "swarm-tools");
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

function runReset(home: string) {
  const proc = Bun.spawnSync([process.execPath, CLI, "reset"], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("swarm reset", () => {
  test("renames an existing swarm.db to a timestamped backup", () => {
    const { home, dir } = makeHome();
    const dbPath = join(dir, "swarm.db");
    writeFileSync(dbPath, "fake-db-content");

    const result = runReset(home);

    expect(result.exitCode).toBe(0);
    expect(existsSync(dbPath)).toBe(false);

    const backups = readdirSync(dir).filter((f) => f.startsWith("swarm.db.reset."));
    expect(backups).toHaveLength(1);

    // Backup is named with a millisecond timestamp.
    const suffix = backups[0]!.slice("swarm.db.reset.".length);
    expect(suffix).toMatch(/^\d+$/);

    // Content is moved, not destroyed.
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe("fake-db-content");
  });

  test("reports the backup path it wrote", () => {
    const { home, dir } = makeHome();
    writeFileSync(join(dir, "swarm.db"), "x");

    const result = runReset(home);

    expect(result.exitCode).toBe(0);
    const backup = readdirSync(dir).find((f) => f.startsWith("swarm.db.reset."))!;
    expect(result.stdout).toContain(join(dir, backup));
  });

  test("is a no-op when there is no database", () => {
    const { home, dir } = makeHome();

    const result = runReset(home);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Aucune DB");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("leaves unrelated files in the swarm-tools directory alone", () => {
    const { home, dir } = makeHome();
    writeFileSync(join(dir, "swarm.db"), "x");
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "s1.jsonl"), "{}\n");

    const result = runReset(home);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, "sessions", "s1.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "sessions", "s1.jsonl"), "utf8")).toBe("{}\n");
  });
});
