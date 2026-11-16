/**
 * Coordinator session event log (append-only JSONL).
 *
 * Same mechanism (and same on-disk format) as the swarm plugin's DECISION
 * events, so `swarm log sessions` and the eval scorers read swarmx violations
 * with no translation:
 *
 *   { session_id, epic_id, timestamp, event_type, violation_type, payload }
 *
 * One line per event at `$SWARM_SESSIONS_DIR/<session_id>.jsonl`
 * (default `~/.config/swarm-tools/sessions`). Writing is best-effort: a broken
 * session log must never fail a tool call or leak into a tool result.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Violation families emitted by the dispatch and completion gates. */
export type SessionViolationType =
  | "missing_worker_protocol"
  | "missing_start_time"
  | "non_canonical_project_key"
  | "skip_bypass_attempt";

/** One JSONL record, structurally aligned with the swarm session capture. */
export interface SessionEvent {
  readonly session_id: string;
  readonly epic_id: string;
  readonly timestamp: string;
  readonly event_type: "VIOLATION" | "DECISION";
  readonly violation_type?: SessionViolationType;
  readonly decision_type?: string;
  readonly payload: Record<string, unknown>;
}

/** Sink injected through the runtime; production appends to the JSONL file. */
export type SessionEventSink = (event: SessionEvent) => void;

/** Payload accepted by {@link emitViolation}. */
export interface SessionViolation {
  /** Session the event belongs to; unknown callers fall back to `"unknown"`. */
  readonly sessionID?: string;
  /** Epic/cell scope when the caller knows it (omitted otherwise). */
  readonly epicID?: string;
  readonly violationType: SessionViolationType;
  readonly payload?: Record<string, unknown>;
}

/** Default directory, matching the swarm plugin's session capture. */
const DEFAULT_SESSIONS_DIR = join(homedir(), ".config", "swarm-tools", "sessions");

/** Session directory, overridable with `$SWARM_SESSIONS_DIR` (tests, CI). */
export function sessionEventsDir(): string {
  const override = process.env.SWARM_SESSIONS_DIR?.trim();
  return override !== undefined && override.length > 0 ? override : DEFAULT_SESSIONS_DIR;
}

/** Absolute path of one session's JSONL log. */
export function sessionEventPath(sessionID: string): string {
  return join(sessionEventsDir(), `${sessionID}.jsonl`);
}

/**
 * Builds the production sink: append one JSON line per event.
 *
 * Failures are swallowed on purpose — the session log is audit evidence, not a
 * gate dependency.
 */
export function createSessionEventWriter(): SessionEventSink {
  return (event) => {
    try {
      mkdirSync(sessionEventsDir(), { recursive: true });
      appendFileSync(sessionEventPath(event.session_id), `${JSON.stringify(event)}\n`, "utf-8");
    } catch {
      // Best-effort only.
    }
  };
}

/**
 * Emits a VIOLATION event through the configured sink.
 *
 * @param sink - runtime sink; omitted runtimes are a silent no-op.
 * @param violation - violation family plus scope and payload.
 */
export interface SessionDecision {
  readonly sessionID?: string;
  readonly epicID?: string;
  readonly decisionType: string;
  readonly payload?: Record<string, unknown>;
}

/** Emits a DECISION event through the configured sink (best-effort). */
export function emitDecision(sink: SessionEventSink | undefined, decision: SessionDecision): void {
  if (sink === undefined) return;
  const sessionID = decision.sessionID?.trim();
  try {
    sink({
      session_id: sessionID !== undefined && sessionID.length > 0 ? sessionID : "unknown",
      epic_id: decision.epicID ?? "",
      timestamp: new Date().toISOString(),
      event_type: "DECISION",
      decision_type: decision.decisionType,
      payload: decision.payload ?? {},
    });
  } catch {
    // A sink failure must never fail the caller.
  }
}

export function emitViolation(sink: SessionEventSink | undefined, violation: SessionViolation): void {
  if (sink === undefined) return;
  const sessionID = violation.sessionID?.trim();
  try {
    sink({
      session_id: sessionID !== undefined && sessionID.length > 0 ? sessionID : "unknown",
      epic_id: violation.epicID ?? "",
      timestamp: new Date().toISOString(),
      event_type: "VIOLATION",
      violation_type: violation.violationType,
      payload: violation.payload ?? {},
    });
  } catch {
    // A sink failure must never fail the caller.
  }
}
