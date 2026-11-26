/**
 * DurableDeferred Service - Distributed Promises
 *
 * Creates a "distributed promise" that can be resolved from anywhere.
 * Useful for request/response patterns over streams.
 *
 * @example
 * ```typescript
 * const response = await DurableDeferred.create<Response>({ ttlSeconds: 60, db })
 * await actor.append({ payload: message, replyTo: response.url })
 * return response.value // blocks until resolved or timeout
 * ```
 *
 * Implementation:
 * - Uses Effect.Deferred internally for blocking await
 * - Stores pending promises in 'deferred' table with TTL
 * - Polls database for resolution (could be upgraded to NOTIFY/LISTEN)
 * - Cleans up expired entries automatically
 */

import { Context, Duration, Effect, Layer } from "effect";
import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../../types/database";

// ============================================================================
// Errors
// ============================================================================

/**
 * Timeout error when deferred expires before resolution
 */
export class TimeoutError extends Error {
  readonly _tag = "TimeoutError";
  constructor(
    public readonly url: string,
    public readonly ttlSeconds: number,
  ) {
    super(`Deferred ${url} timed out after ${ttlSeconds}s`);
  }
}

/**
 * Not found error when deferred URL doesn't exist
 */
export class NotFoundError extends Error {
  readonly _tag = "NotFoundError";
  constructor(public readonly url: string) {
    super(`Deferred ${url} not found`);
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Handle for a pending deferred promise
 */
export interface DeferredHandle<T> {
  /** Unique URL/identifier for this deferred */
  readonly url: string;
  /** Blocks until resolved/rejected or timeout */
  readonly value: Effect.Effect<T, TimeoutError | NotFoundError>;
}

/**
 * Configuration for creating a deferred
 */
export interface DeferredConfig {
  /** Time-to-live in seconds before timeout */
  readonly ttlSeconds: number;
  /** Database adapter for storage */
  readonly db: DatabaseAdapter;
  /** Optional stable key; produces `deferred:<key>` instead of a random URL. */
  readonly key?: string;
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * DurableDeferred service for distributed promises
 */
export class DurableDeferred extends Context.Tag("DurableDeferred")<
  DurableDeferred,
  {
    /**
     * Create a new deferred promise
     *
     * @returns Handle with URL and value getter
     */
    readonly create: <T>(
      config: DeferredConfig,
    ) => Effect.Effect<DeferredHandle<T>>;

    /**
     * Resolve a deferred with a value
     *
     * @param url - Deferred identifier
     * @param value - Resolution value
     * @param db - Database adapter
     */
    readonly resolve: <T>(
      url: string,
      value: T,
      db: DatabaseAdapter,
    ) => Effect.Effect<void, NotFoundError>;

    /**
     * Reject a deferred with an error
     *
     * @param url - Deferred identifier
     * @param error - Error to reject with
     * @param db - Database adapter
     */
    readonly reject: (
      url: string,
      error: Error,
      db: DatabaseAdapter,
    ) => Effect.Effect<void, NotFoundError>;

    /**
     * Await a deferred's resolution (internal - use handle.value instead)
     */
    readonly await: <T>(
      url: string,
      ttlSeconds: number,
      db: DatabaseAdapter,
    ) => Effect.Effect<T, TimeoutError | NotFoundError>;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Ensure deferred table exists in database (SQLite syntax)
 */
async function ensureDeferredTable(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS deferred (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      resolved INTEGER NOT NULL DEFAULT 0,
      value TEXT,
      error TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deferred_url ON deferred(url);
    CREATE INDEX IF NOT EXISTS idx_deferred_expires ON deferred(expires_at);
  `);
}

/**
 * Clean up expired deferred entries
 */
async function cleanupExpired(db: DatabaseAdapter): Promise<number> {
  const now = Date.now();
  
  // Count expired entries first
  const countResult = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM deferred WHERE expires_at < ?`,
    [now],
  );
  const count = countResult.rows[0]?.count ?? 0;
  
  // Delete expired entries (use parameterized query)
  await db.query(`DELETE FROM deferred WHERE expires_at < ?`, [now]);
  
  return count;
}

/**
 * Create implementation
 */
function createImpl<T>(
  config: DeferredConfig,
): Effect.Effect<DeferredHandle<T>> {
  return Effect.gen(function* () {
    const { db, ttlSeconds, key } = config;

    // Ensure table exists
    yield* Effect.promise(() => ensureDeferredTable(db));

    // Generate a unique URL or use the caller's stable key.
    const url = key === undefined ? `deferred:${nanoid()}` : `deferred:${key}`;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const createdAt = Date.now();

    // Insert into database (use parameterized query)
    yield* Effect.promise(() =>
      db.query(
        `INSERT INTO deferred (url, resolved, expires_at, created_at) VALUES (?, 0, ?, ?)`,
        [url, expiresAt, createdAt],
      ),
    );

    // Create value getter that directly calls awaitImpl (doesn't need service context)
    const value: Effect.Effect<T, TimeoutError | NotFoundError> = awaitImpl<T>(
      url,
      ttlSeconds,
      db,
    );

    return { url, value };
  });
}

/**
 * Resolve implementation
 */
function resolveImpl<T>(
  url: string,
  value: T,
  db: DatabaseAdapter,
): Effect.Effect<void, NotFoundError> {
  return Effect.gen(function* () {
    yield* Effect.promise(() => ensureDeferredTable(db));

    // Check if deferred exists and is not resolved
    const checkResult = yield* Effect.promise(() =>
      db.query<{ url: string; resolved: number }>(
        `SELECT url, resolved FROM deferred WHERE url = ? AND resolved = 0`,
        [url],
      ),
    );

    if (checkResult.rows.length === 0) {
      yield* Effect.fail(new NotFoundError(url));
      return;
    }

    // Update database with serialized value
    const serializedValue = JSON.stringify(value);
    yield* Effect.promise(() =>
      db.query(
        `UPDATE deferred SET resolved = 1, value = ? WHERE url = ? AND resolved = 0`,
        [serializedValue, url],
      ),
    );
  });
}

/**
 * Reject implementation
 */
function rejectImpl(
  url: string,
  error: Error,
  db: DatabaseAdapter,
): Effect.Effect<void, NotFoundError> {
  return Effect.gen(function* () {
    yield* Effect.promise(() => ensureDeferredTable(db));

    // Check if deferred exists and is not resolved
    const checkResult = yield* Effect.promise(() =>
      db.query<{ url: string; resolved: number }>(
        `SELECT url, resolved FROM deferred WHERE url = ? AND resolved = 0`,
        [url],
      ),
    );

    if (checkResult.rows.length === 0) {
      yield* Effect.fail(new NotFoundError(url));
      return;
    }

    // Update database with error
    yield* Effect.promise(() =>
      db.query(
        `UPDATE deferred SET resolved = 1, error = ? WHERE url = ? AND resolved = 0`,
        [error.message, url],
      ),
    );
  });
}

/**
 * Await implementation (polls the database so cross-process resolution works)
 */
function awaitImpl<T>(
  url: string,
  ttlSeconds: number,
  db: DatabaseAdapter,
): Effect.Effect<T, TimeoutError | NotFoundError> {
  return Effect.gen(function* () {
    yield* Effect.promise(() => ensureDeferredTable(db));

    const startTime = Date.now();
    const timeoutMs = ttlSeconds * 1000;

    // Poll loop
    while (true) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        return yield* Effect.fail(new TimeoutError(url, ttlSeconds));
      }

      // Query database
      const result = yield* Effect.promise(() =>
        db.query<{ resolved: number; value: string | null; error: string | null }>(
          `SELECT resolved, value, error FROM deferred WHERE url = ?`,
          [url],
        ),
      );

      const row = result.rows[0];
      if (!row) {
        return yield* Effect.fail(new NotFoundError(url));
      }

      // Check if resolved (SQLite uses 0/1 for boolean)
      if (row.resolved === 1) {
        if (row.error) {
          // Convert stored error message to NotFoundError
          return yield* Effect.fail(new NotFoundError(url));
        }
        // Value should exist if resolved=1 and error=null
        if (!row.value) {
          return yield* Effect.fail(new NotFoundError(url));
        }
        // Parse JSON value
        return JSON.parse(row.value) as T;
      }

      // Sleep before next poll (100ms)
      yield* Effect.sleep(Duration.millis(100));
    }
  });
}

// ============================================================================
// Layer
// ============================================================================

/**
 * Live implementation of DurableDeferred service
 */
export const DurableDeferredLive = Layer.succeed(DurableDeferred, {
  create: createImpl,
  resolve: resolveImpl,
  reject: rejectImpl,
  await: awaitImpl,
});

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a deferred promise
 */
export function createDeferred<T>(
  config: DeferredConfig,
): Effect.Effect<DeferredHandle<T>, never, DurableDeferred> {
  return Effect.gen(function* () {
    const service = yield* DurableDeferred;
    return yield* service.create<T>(config);
  });
}

/**
 * Resolve a deferred
 */
export function resolveDeferred<T>(
  url: string,
  value: T,
  db: DatabaseAdapter,
): Effect.Effect<void, NotFoundError, DurableDeferred> {
  return Effect.gen(function* () {
    const service = yield* DurableDeferred;
    return yield* service.resolve(url, value, db);
  });
}

/**
 * Reject a deferred
 */
export function rejectDeferred(
  url: string,
  error: Error,
  db: DatabaseAdapter,
): Effect.Effect<void, NotFoundError, DurableDeferred> {
  return Effect.gen(function* () {
    const service = yield* DurableDeferred;
    return yield* service.reject(url, error, db);
  });
}

/**
 * Cleanup expired deferred entries (call periodically)
 */
export function cleanupDeferreds(db: DatabaseAdapter): Effect.Effect<number> {
  return Effect.promise(() => cleanupExpired(db));
}
