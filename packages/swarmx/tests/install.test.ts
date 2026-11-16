import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  install,
  upgrade,
  doctor,
  uninstall,
  resolveAssetsDir,
  resolveTargetDir,
} from "../bin/swarmx";

const dirs: string[] = [];

function tempTarget(): string {
  const root = mkdtempSync(join(tmpdir(), "swarmx-install-"));
  dirs.push(root);
  return join(root, ".opencode");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("swarmx install", () => {
  test("installs 4 agents, 1 command and 3 skills", async () => {
    const target = tempTarget();
    const result = await install({ target, assetsDir: resolveAssetsDir() });

    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "agents/swarm/swarm-coordinator.md"))).toBe(true);
    expect(existsSync(join(target, "agents/swarm/swarm-planner.md"))).toBe(true);
    expect(existsSync(join(target, "agents/swarm/swarm-researcher.md"))).toBe(true);
    expect(existsSync(join(target, "agents/swarm/swarm-worker.md"))).toBe(true);
    expect(existsSync(join(target, "commands/swarmx.md"))).toBe(true);
    expect(existsSync(join(target, "skills/swarm-coordination/SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "skills/swarm-worker-protocol/SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "skills/swarm-jira-import/SKILL.md"))).toBe(true);

    const manifestPath = join(target, ".swarmx", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.assets["agents/swarm/swarm-coordinator.md"]).toMatch(/^sha256-/);
  });

  test("is idempotent", async () => {
    const target = tempTarget();
    await install({ target, assetsDir: resolveAssetsDir() });
    await install({ target, assetsDir: resolveAssetsDir() });
    const doctorResult = await doctor({ target, assetsDir: resolveAssetsDir() });
    expect(doctorResult.ok).toBe(true);
  });
});

describe("swarmx upgrade", () => {
  test("updates only changed assets", async () => {
    const target = tempTarget();
    await install({ target, assetsDir: resolveAssetsDir() });

    // tamper with one file
    const file = join(target, "agents/swarm/swarm-worker.md");
    writeFileSync(file, "tampered content");

    const result = await upgrade({ target, assetsDir: resolveAssetsDir() });
    expect(result.ok).toBe(true);
    expect(result.updated).toContain("agents/swarm/swarm-worker.md");
    expect(readFileSync(file, "utf8")).not.toBe("tampered content");

    const doctorResult = await doctor({ target, assetsDir: resolveAssetsDir() });
    expect(doctorResult.ok).toBe(true);
  });
});

describe("swarmx doctor", () => {
  test("detects missing asset", async () => {
    const target = tempTarget();
    await install({ target, assetsDir: resolveAssetsDir() });
    rmSync(join(target, "commands/swarmx.md"), { force: true });
    const result = await doctor({ target, assetsDir: resolveAssetsDir() });
    expect(result.ok).toBe(false);
    expect(result.issues?.some((i) => i.includes("missing asset"))).toBe(true);
  });

  test("detects hash divergence", async () => {
    const target = tempTarget();
    await install({ target, assetsDir: resolveAssetsDir() });
    writeFileSync(join(target, "commands/swarmx.md"), "changed");
    const result = await doctor({ target, assetsDir: resolveAssetsDir() });
    expect(result.ok).toBe(false);
    expect(result.issues?.some((i) => i.includes("modified") || i.includes("outdated"))).toBe(true);
  });
});

describe("swarmx uninstall", () => {
  test("removes only managed assets", async () => {
    const target = tempTarget();
    await install({ target, assetsDir: resolveAssetsDir() });

    const unmanaged = join(target, "skills/swarm-worker-protocol/UNMANAGED.md");
    mkdirSync(join(target, "skills/swarm-worker-protocol"), { recursive: true });
    writeFileSync(unmanaged, "keep me");

    await uninstall({ target, assetsDir: resolveAssetsDir() });

    expect(existsSync(join(target, "agents/swarm/swarm-coordinator.md"))).toBe(false);
    expect(existsSync(join(target, "commands/swarmx.md"))).toBe(false);
    expect(existsSync(join(target, "skills/swarm-worker-protocol/SKILL.md"))).toBe(false);
    expect(existsSync(unmanaged)).toBe(true);
    expect(existsSync(join(target, ".swarmx", "manifest.json"))).toBe(false);
  });
});