import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const GLOBAL_DATABASE_PATH = join(homedir(), ".config", "swarm-tools", "swarm.db");

export function assertSafeTestDatabasePath(path: string): void {
  if (resolve(path) === resolve(GLOBAL_DATABASE_PATH)) {
    throw new Error(`Refusing to use the global database in tests: ${GLOBAL_DATABASE_PATH}`);
  }
}

export async function createTestDatabasePath(prefix = "swarm-test"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const path = join(directory, "swarm.db");
  assertSafeTestDatabasePath(path);
  return path;
}

export async function removeTestDatabasePath(path: string): Promise<void> {
  assertSafeTestDatabasePath(path);
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}
