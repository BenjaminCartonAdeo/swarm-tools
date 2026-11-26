import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const GLOBAL_DATABASE_PATH = join(homedir(), ".config", "swarm-tools", "swarm.db");

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let ancestor = absolute;
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

export function assertSafeTestDatabasePath(path: string): void {
  if (canonicalPath(path) === canonicalPath(GLOBAL_DATABASE_PATH)) {
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
