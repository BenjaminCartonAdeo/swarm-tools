/**
 * Coordinator context-pressure watchdog.
 *
 * Large coordinator contexts degrade dispatch quality and eventually hit the
 * host's truncation/compaction path mid-mission. This module classifies the
 * coordinator session's cumulative input tokens and emits **at most one**
 * notice per threshold per context lifecycle:
 *
 *   - ≥ 300 000 input tokens → `warning` (keep going, plan a compaction soon);
 *   - ≥ 500 000 input tokens → `notice`  (compact/checkpoint before the next
 *     dispatch).
 *
 * Design rules:
 *   - **Non-fatal**: the watchdog only produces text. The caller decides how to
 *     surface it; no exception, no tool-result mutation, no permission change.
 *   - **Pure**: classification and de-duplication are synchronous and clock-free,
 *     so tests can drive them with plain numbers.
 *   - **Resettable**: once the context drops back below the warning threshold
 *     (a compaction/checkpoint happened), the session is forgotten and a later
 *     crossing warns again.
 */

/** Input-token count at which the coordinator gets a warning. */
export const TOKEN_WARN_THRESHOLD = 300_000;

/** Input-token count at which the coordinator gets a compact/checkpoint notice. */
export const TOKEN_NOTICE_THRESHOLD = 500_000;

/** Hook name registered by the plugin (matches `SessionHooks["context"]`). */
export const TOKEN_PRESSURE_HOOK_NAME = "context" as const;

/** Severity of a context-pressure notice, ordered by rank. */
export type TokenPressureLevel = "warning" | "notice";

/** One emitted notice; `text` is ready to push as a system text part. */
export interface TokenPressureNotice {
  readonly level: TokenPressureLevel;
  /** Input tokens observed when the notice was emitted. */
  readonly inputTokens: number;
  /** Threshold that was crossed. */
  readonly threshold: number;
  /** Advisory text, including the compact/checkpoint suggestion. */
  readonly text: string;
}

/** Optional thresholds (tests and future tuning); production uses the constants. */
export interface TokenWatchdogOptions {
  readonly warnAt?: number;
  readonly noticeAt?: number;
}

/** De-duplicating classifier; one instance per plugin setup. */
export interface TokenWatchdog {
  /**
   * Classifies one observation.
   *
   * @param sessionID - coordinator session the tokens belong to.
   * @param inputTokens - cumulative input tokens; non-finite/negative values
   *   are ignored (no notice, no state change).
   * @returns A notice only when the session crosses a *new* threshold.
   */
  evaluate(sessionID: string, inputTokens: number): TokenPressureNotice | undefined;
  /** Forgets one session (or every session when called without an argument). */
  reset(sessionID?: string): void;
}

const LEVEL_RANK: Readonly<Record<TokenPressureLevel, number>> = {
  warning: 1,
  notice: 2,
};

/** Formats the advisory text for a threshold crossing. */
function buildText(level: TokenPressureLevel, inputTokens: number): string {
  const tokens = inputTokens.toLocaleString("en-US");
  if (level === "notice") {
    return (
      `<swarmx_token_pressure level="notice" input="${tokens}">` +
      "Coordinator context is very large. Run /compact or /checkpoint before the next dispatch " +
      "to avoid truncation mid-mission." +
      "</swarmx_token_pressure>"
    );
  }
  return (
    `<swarmx_token_pressure level="warning" input="${tokens}">` +
    "Coordinator context is growing. Plan a /compact or /checkpoint before dispatching more work." +
    "</swarmx_token_pressure>"
  );
}

/**
 * Builds a de-duplicating watchdog.
 *
 * @param options - threshold overrides (must satisfy `0 < warnAt < noticeAt`).
 * @throws RangeError when the thresholds are not ordered.
 */
export function createTokenWatchdog(options: TokenWatchdogOptions = {}): TokenWatchdog {
  const warnAt = options.warnAt ?? TOKEN_WARN_THRESHOLD;
  const noticeAt = options.noticeAt ?? TOKEN_NOTICE_THRESHOLD;
  if (!(warnAt > 0) || !(noticeAt > warnAt)) {
    throw new RangeError(`swarmx token watchdog: expected 0 < warnAt < noticeAt (got ${warnAt}/${noticeAt})`);
  }

  const lastLevel = new Map<string, TokenPressureLevel>();

  return {
    evaluate(sessionID, inputTokens) {
      if (!Number.isFinite(inputTokens) || inputTokens < 0) return undefined;
      if (inputTokens < warnAt) {
        // A compaction/checkpoint brought the context back down: allow a later
        // crossing to warn again instead of staying silent for the whole session.
        lastLevel.delete(sessionID);
        return undefined;
      }
      const level: TokenPressureLevel = inputTokens >= noticeAt ? "notice" : "warning";
      const previous = lastLevel.get(sessionID);
      if (previous !== undefined && LEVEL_RANK[level] <= LEVEL_RANK[previous]) {
        return undefined;
      }
      lastLevel.set(sessionID, level);
      return {
        level,
        inputTokens,
        threshold: level === "notice" ? noticeAt : warnAt,
        text: buildText(level, inputTokens),
      };
    },
    reset(sessionID) {
      if (sessionID === undefined) lastLevel.clear();
      else lastLevel.delete(sessionID);
    },
  };
}
