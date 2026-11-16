/**
 * Pre-decomposition history lookup (P1.10).
 *
 * Before `swarm_decompose` / `swarm_plan_prompt` runs, swarmx asks
 * `hivemind_find` what the hive already knows about the task:
 *
 *   - hits → rendered into the decomposition `context` argument, so the
 *     planner reuses proven approaches instead of rediscovering them;
 *   - no hits → an explicit warning is carried in the tool result. The
 *     decomposition still runs: history is advisory, never a gate;
 *   - lookup failure → same non-blocking warning path (`lookup failed`).
 *
 * The normaliser is deliberately tolerant: `hivemind_find` can answer as a
 * parsed object (`{ results }`), a JSON string, or an MCP envelope
 * (`{ content: [{ text }] }`). Unknown shapes degrade to "no history" rather
 * than throwing — a malformed memory record must never block planning.
 */
import type { SwarmxRuntime } from "./types";

/** Backend tool queried before decomposition. */
export const HISTORY_TOOL_NAME = "hivemind_find";

/** Default number of memories requested for one decomposition. */
export const DECOMPOSITION_HISTORY_LIMIT = 5;

/** Deadline for the lookup; decomposition waits at most this long. */
export const DECOMPOSITION_HISTORY_TIMEOUT_MS = 15_000;

/** Heading of the block injected into the decomposition context. */
export const HISTORY_CONTEXT_HEADING = "## Related history (hivemind_find)";

/** Opening sentence of the empty-history warning. */
export const HISTORY_WARNING_PREFIX = "No related history found in hivemind";

/** A long memory is truncated so the decomposition prompt stays bounded. */
export const HISTORY_HIT_MAX_CHARS = 400;

/** One normalised memory hit. */
export interface HistoryHit {
  readonly id: string;
  readonly information: string;
  readonly score?: number;
  readonly collection?: string;
}

/** Outcome of the pre-decomposition lookup. */
export interface DecompositionHistory {
  readonly hits: readonly HistoryHit[];
  /** Non-blocking warning: nothing found, or the lookup itself failed. */
  readonly warning?: string;
  /** Block to append to the decomposition `context`; absent when empty. */
  readonly context?: string;
}

/** Options for {@link queryDecompositionHistory}. */
export interface QueryHistoryOptions {
  readonly sessionID?: string;
  readonly limit?: number;
  readonly timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parses one JSON string level; non-JSON strings pass through untouched. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function arrayAt(value: unknown, key: string): readonly unknown[] | undefined {
  const record = asRecord(value);
  const nested = record?.[key];
  if (Array.isArray(nested)) return nested;
  const parsed = parseJson(nested);
  return Array.isArray(parsed) ? parsed : undefined;
}

/**
 * Unwraps the payload shapes `hivemind_find` is known to produce.
 *
 * @returns The candidate item array, or `[]` for an unrecognised payload.
 */
function candidateItems(raw: unknown): readonly unknown[] {
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) return parsed;

  for (const key of ["results", "memories", "data", "items"] as const) {
    const found = arrayAt(parsed, key);
    if (found !== undefined) return found;
  }

  // MCP transport envelope: `{ content: [{ type: "text", text: "…json…" }] }`.
  const record = asRecord(parsed);
  const content = record?.content;
  if (Array.isArray(content)) {
    const items: unknown[] = [];
    for (const part of content) {
      const text = asRecord(part)?.text;
      if (typeof text !== "string") continue;
      const inner = parseJson(text);
      const nested = candidateItems(inner);
      if (nested.length > 0) items.push(...nested);
      else if (inner !== undefined) items.push(inner);
    }
    return items;
  }

  return [];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toHit(item: unknown, index: number): HistoryHit | undefined {
  const fallbackID = `hit-${index + 1}`;
  const asText = textOf(item);
  if (asText !== undefined) return { id: fallbackID, information: truncate(asText) };

  const record = asRecord(item);
  if (record === undefined) return undefined;
  const memory = asRecord(record.memory);

  const information =
    textOf(record.information) ??
    textOf(record.content) ??
    textOf(record.text) ??
    textOf(memory?.content);
  if (information === undefined) return undefined;

  const score = numberOf(record.score) ?? numberOf(record.similarity);
  const collection = textOf(record.collection) ?? textOf(memory?.collection);
  return {
    id: textOf(record.id) ?? textOf(memory?.id) ?? fallbackID,
    information: truncate(information),
    ...(score === undefined ? {} : { score }),
    ...(collection === undefined ? {} : { collection }),
  };
}

function truncate(value: string): string {
  return value.length <= HISTORY_HIT_MAX_CHARS
    ? value
    : `${value.slice(0, HISTORY_HIT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Normalises an arbitrary `hivemind_find` payload into hits.
 *
 * @param raw - backend payload (object, JSON string or MCP envelope).
 * @returns Deduplicated hits, in backend order.
 */
export function normalizeHistoryHits(raw: unknown): HistoryHit[] {
  const hits: HistoryHit[] = [];
  const seen = new Set<string>();
  candidateItems(raw).forEach((item, index) => {
    const hit = toHit(item, index);
    if (hit === undefined) return;
    const key = `${hit.id}\u0000${hit.information}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  });
  return hits;
}

/**
 * Renders hits as a markdown block for the decomposition `context`.
 *
 * @param hits - non-empty normalised history.
 */
export function renderHistoryContext(hits: readonly HistoryHit[]): string {
  const lines = hits.map((hit) => {
    const meta = [
      hit.id,
      hit.collection === undefined ? undefined : `collection ${hit.collection}`,
      hit.score === undefined ? undefined : `score ${hit.score.toFixed(2)}`,
    ].filter((value): value is string => value !== undefined);
    const label = meta.length === 0 ? "" : `[${meta.join(" · ")}] `;
    return `- ${label}${hit.information.replace(/\s+/g, " ")}`;
  });
  return [
    HISTORY_CONTEXT_HEADING,
    "Past work found for this task — reuse proven approaches, avoid known failures.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Builds the warning emitted when the lookup returned nothing usable.
 *
 * @param task - task being decomposed (quoted back for auditability).
 * @param detail - optional failure detail (`lookup failed: …`).
 */
export function emptyHistoryWarning(task: string, detail?: string): string {
  const suffix = detail === undefined ? "" : ` (${detail})`;
  return (
    `${HISTORY_WARNING_PREFIX} for "${task}"${suffix} — ` +
    "decomposition continues without prior patterns (non-blocking)."
  );
}

/**
 * Turns a raw backend payload into the decomposition history contribution.
 *
 * @param task - task being decomposed.
 * @param raw - `hivemind_find` payload.
 */
export function buildDecompositionHistory(task: string, raw: unknown): DecompositionHistory {
  const hits = normalizeHistoryHits(raw);
  if (hits.length === 0) {
    return { hits, warning: emptyHistoryWarning(task) };
  }
  return { hits, context: renderHistoryContext(hits) };
}

/**
 * Queries `hivemind_find` for history related to a task.
 *
 * Never throws: a failed lookup becomes an explicit, non-blocking warning so
 * decomposition proceeds on a cold hive (first mission, missing index, timeout).
 *
 * @param runtime - backend execution boundary (`runTool`).
 * @param task - task about to be decomposed.
 * @param options - session scope, result limit and deadline.
 */
export async function queryDecompositionHistory(
  runtime: Pick<SwarmxRuntime, "runTool">,
  task: string,
  options: QueryHistoryOptions = {},
): Promise<DecompositionHistory> {
  const limit = options.limit ?? DECOMPOSITION_HISTORY_LIMIT;
  try {
    const raw = await runtime.runTool(
      HISTORY_TOOL_NAME,
      { query: task, limit },
      {
        ...(options.sessionID === undefined
          ? {}
          : { env: { OPENCODE_SESSION_ID: options.sessionID } }),
        timeoutMs: options.timeoutMs ?? DECOMPOSITION_HISTORY_TIMEOUT_MS,
      },
    );
    return buildDecompositionHistory(task, raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { hits: [], warning: emptyHistoryWarning(task, `lookup failed: ${message}`) };
  }
}

/**
 * Appends the history block to an existing decomposition `context` argument.
 *
 * @param args - backend arguments about to be forwarded.
 * @param history - outcome of {@link queryDecompositionHistory}.
 * @returns The original arguments when there is nothing to inject.
 */
export function injectHistoryContext(
  args: Record<string, unknown>,
  history: DecompositionHistory,
): Record<string, unknown> {
  if (history.context === undefined) return args;
  const existing = textOf(args.context);
  return {
    ...args,
    context: existing === undefined ? history.context : `${existing}\n\n${history.context}`,
  };
}

/**
 * Carries the lookup outcome in the decomposition tool result.
 *
 * A JSON result (the normal `swarm_decompose`/`swarm_plan_prompt` shape) gains
 * a `history` field mirroring the backend's `cass_history` convention; a plain
 * string result gets the warning appended so it stays visible to the model.
 *
 * @param output - raw backend result.
 * @param history - outcome of {@link queryDecompositionHistory}.
 */
export function attachHistorySummary(output: unknown, history: DecompositionHistory): unknown {
  const summary: Record<string, unknown> = {
    queried: true,
    results_found: history.hits.length,
    ...(history.warning === undefined ? {} : { warning: history.warning }),
  };

  const parsed = typeof output === "string" ? parseJson(output) : output;
  const record = asRecord(parsed);
  if (record !== undefined && typeof record.prompt === "string") {
    return { ...record, history: summary };
  }
  if (typeof output === "string" && output.trim().length > 0) {
    return history.warning === undefined ? output : `${output}\n\n> ⚠️ ${history.warning}`;
  }
  return { ...(record ?? {}), history: summary };
}
