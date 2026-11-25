import { beforeEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";

import {
  BUILD_LOCK_STALE_MS,
  CLEANUP_LOCK_STALE_MS,
  acquireWorkUnitLock,
  buildLockName,
  cleanupLockName,
  isWorkUnitLockActive,
  releaseWorkUnitLock,
} from "../src/workunit/locks";
import { ensureWorkUnitSchema } from "../src/workunit/schema";

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await createLibSQLAdapter({ url: ":memory:" });
  await ensureWorkUnitSchema(db);
});

const name = buildLockName("proj");

describe("WorkUnit SQL lock", () => {
  test("uses build:/cleanup: names and 15/5 minute stale windows", () => {
    expect(buildLockName("p")).toBe("build:p");
    expect(cleanupLockName("p")).toBe("cleanup:p");
    expect(BUILD_LOCK_STALE_MS).toBe(15 * 60_000);
    expect(CLEANUP_LOCK_STALE_MS).toBe(5 * 60_000);
  });

  test("lock contention: a fresh holder blocks a second acquirer", async () => {
    const first = await acquireWorkUnitLock(db, { name, token: "a", ownerSession: "s1", now: 1_000, staleAfterMs: BUILD_LOCK_STALE_MS });
    expect(first).toEqual({ acquired: true, fence: 1 });
    const second = await acquireWorkUnitLock(db, { name, token: "b", ownerSession: "s2", now: 2_000, staleAfterMs: BUILD_LOCK_STALE_MS });
    expect(second).toEqual({ acquired: false });
    expect(await isWorkUnitLockActive(db, { name, now: 2_000, staleAfterMs: BUILD_LOCK_STALE_MS })).toBe(true);
  });

  test("lock stale reclaim increments the fence", async () => {
    await acquireWorkUnitLock(db, { name, token: "a", ownerSession: "s1", now: 0, staleAfterMs: BUILD_LOCK_STALE_MS });
    const later = BUILD_LOCK_STALE_MS + 1;
    expect(await isWorkUnitLockActive(db, { name, now: later, staleAfterMs: BUILD_LOCK_STALE_MS })).toBe(false);
    const reclaimed = await acquireWorkUnitLock(db, { name, token: "b", ownerSession: "s2", now: later, staleAfterMs: BUILD_LOCK_STALE_MS });
    expect(reclaimed).toEqual({ acquired: true, fence: 2 });
  });

  test("lock stale owner release is a lost-ownership no-op", async () => {
    await acquireWorkUnitLock(db, { name, token: "a", ownerSession: "s1", now: 0, staleAfterMs: CLEANUP_LOCK_STALE_MS });
    await acquireWorkUnitLock(db, { name, token: "b", ownerSession: "s2", now: CLEANUP_LOCK_STALE_MS + 1, staleAfterMs: CLEANUP_LOCK_STALE_MS });
    expect(await releaseWorkUnitLock(db, { name, token: "a", fence: 1 })).toBe(false);
    expect(await isWorkUnitLockActive(db, { name, now: CLEANUP_LOCK_STALE_MS + 2, staleAfterMs: CLEANUP_LOCK_STALE_MS })).toBe(true);
    expect(await releaseWorkUnitLock(db, { name, token: "b", fence: 2 })).toBe(true);
    expect(await isWorkUnitLockActive(db, { name, now: CLEANUP_LOCK_STALE_MS + 2, staleAfterMs: CLEANUP_LOCK_STALE_MS })).toBe(false);
  });

  test("lock release with a wrong fence deletes nothing", async () => {
    await acquireWorkUnitLock(db, { name, token: "a", ownerSession: "s1", now: 0, staleAfterMs: BUILD_LOCK_STALE_MS });
    expect(await releaseWorkUnitLock(db, { name, token: "a", fence: 9 })).toBe(false);
    expect(await isWorkUnitLockActive(db, { name, now: 1, staleAfterMs: BUILD_LOCK_STALE_MS })).toBe(true);
  });

  test("lock reclaim loses when another reclaimer already advanced the fence", async () => {
    await acquireWorkUnitLock(db, { name, token: "a", ownerSession: "s1", now: 0, staleAfterMs: 10 });
    const [x, y] = await Promise.all([
      acquireWorkUnitLock(db, { name, token: "b", ownerSession: "s2", now: 100, staleAfterMs: 10 }),
      acquireWorkUnitLock(db, { name, token: "c", ownerSession: "s3", now: 100, staleAfterMs: 10 }),
    ]);
    expect([x.acquired, y.acquired].filter(Boolean)).toHaveLength(1);
  });
});
