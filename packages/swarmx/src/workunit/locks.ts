/**
 * Project-scoped SQL locks (`swarmx_locks`) for build/test serialization and
 * worktree cleanup claims.
 *
 * Acquire is a conditional INSERT; a stale holder is reclaimed by a CAS UPDATE
 * on token/fence/acquired_at that increments the fence. Release deletes only on
 * a matching name/token/fence. Zero affected rows always means contention,
 * failed reclaim or lost ownership — never success.
 */
import type { DatabaseAdapter } from "swarm-mail";

export const BUILD_LOCK_STALE_MS = 15 * 60 * 1000;
export const CLEANUP_LOCK_STALE_MS = 5 * 60 * 1000;

export function buildLockName(project: string): string {
  return `build:${project}`;
}

export function cleanupLockName(project: string): string {
  return `cleanup:${project}`;
}

export type WorkUnitLockAcquisition = { acquired: true; fence: number } | { acquired: false };

interface LockRow {
  token: string;
  fence: number;
  acquired_at: number;
}

async function readLock(db: DatabaseAdapter, name: string): Promise<LockRow | undefined> {
  const result = await db.query<LockRow>(
    "SELECT token, fence, acquired_at FROM swarmx_locks WHERE name = ?",
    [name],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { token: String(row.token), fence: Number(row.fence), acquired_at: Number(row.acquired_at) };
}

export async function acquireWorkUnitLock(
  db: DatabaseAdapter,
  input: { name: string; token: string; ownerSession: string; now: number; staleAfterMs: number },
): Promise<WorkUnitLockAcquisition> {
  const inserted = await db.query<{ fence: number }>(
    `INSERT INTO swarmx_locks (name, token, owner_session, fence, acquired_at)
     VALUES (?, ?, ?, 1, ?) ON CONFLICT(name) DO NOTHING RETURNING fence`,
    [input.name, input.token, input.ownerSession, input.now],
  );
  if (inserted.rows[0] !== undefined) return { acquired: true, fence: Number(inserted.rows[0].fence) };
  const current = await readLock(db, input.name);
  if (current === undefined || input.now - current.acquired_at < input.staleAfterMs) return { acquired: false };
  const reclaimed = await db.query<{ fence: number }>(
    `UPDATE swarmx_locks SET token = ?, owner_session = ?, fence = fence + 1, acquired_at = ?
     WHERE name = ? AND token = ? AND fence = ? AND acquired_at = ? RETURNING fence`,
    [input.token, input.ownerSession, input.now, input.name, current.token, current.fence, current.acquired_at],
  );
  const row = reclaimed.rows[0];
  return row === undefined ? { acquired: false } : { acquired: true, fence: Number(row.fence) };
}

export async function releaseWorkUnitLock(
  db: DatabaseAdapter,
  input: { name: string; token: string; fence: number },
): Promise<boolean> {
  const deleted = await db.query(
    "DELETE FROM swarmx_locks WHERE name = ? AND token = ? AND fence = ? RETURNING name",
    [input.name, input.token, input.fence],
  );
  return deleted.rows.length > 0;
}

export async function isWorkUnitLockActive(
  db: DatabaseAdapter,
  input: { name: string; now: number; staleAfterMs: number },
): Promise<boolean> {
  const current = await readLock(db, input.name);
  return current !== undefined && input.now - current.acquired_at < input.staleAfterMs;
}
