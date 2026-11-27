import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("getSwarmMailDatabaseAdapterUsesCachedGlobalAdapter", async () => {
  const testDirectory = await mkdtemp(join(tmpdir(), "swarm-mail-adapter-"));
  const projectPath = join(testDirectory, "project");
  const databasePath = join(testDirectory, "configured", "swarm.db");
  const storeUrl = new URL("./store.ts", import.meta.url).href;

  await mkdir(projectPath);
  await mkdir(join(testDirectory, "configured"));

  const childScript = `
    const store = await import(${JSON.stringify(storeUrl)});
    const getAdapter = Reflect.get(store, "getSwarmMailDatabaseAdapter");
    if (typeof getAdapter !== "function") {
      throw new Error("getSwarmMailDatabaseAdapter is not exported");
    }
    const first = await getAdapter(${JSON.stringify(projectPath)});
    const second = await getAdapter(${JSON.stringify(projectPath)});
    if (first !== second) {
      throw new Error("Repeated calls did not return the cached adapter");
    }
    const packageEntry = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
    if (packageEntry.getSwarmMailDatabaseAdapter !== getAdapter) {
      throw new Error("The package barrel does not re-export the adapter accessor");
    }
  `;

  try {
    const child = Bun.spawnSync(["bun", "--eval", childScript], {
      cwd: import.meta.dir,
      env: { ...process.env, SWARM_DB_PATH: databasePath },
    });

    if (child.exitCode !== 0) {
      throw new Error(child.stderr.toString() || child.stdout.toString());
    }
    expect(await stat(databasePath).then(() => true, () => false)).toBe(true);
    expect(
      await stat(join(projectPath, ".opencode", "streams.db")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});
