/**
 * Compaction contribution: factual mission summary injected into the system
 * prompt when the host compacts a session.
 *
 * The builder is **pure** — no I/O, no CLI, no LLM, no clock. It only projects
 * the mission state and the optional ledger/assignment snapshot onto a bounded,
 * deterministic fact sheet, so the model compaction keeps operating on an
 * enriched context instead of being replaced (`event.result` is never set).
 *
 * Content rules:
 *   - whitelisted facts only (mode, budget, counters, cells, ready cells,
 *     invariants) — never a prompt, a description, `sharedContext`, tool args
 *     or environment;
 *   - every emitted value is sanitized (control characters collapsed) and
 *     secret-shaped assignments (`token=...`, `password=...`) are redacted;
 *   - lists are capped and the whole text is clamped to {@link MAX_FACTS_BYTES}
 *     UTF-8 bytes, with a stable omission marker.
 */
import { selectCells, selectMissionSummary, selectReadyCells } from "./state";
import type {
  DispatchAttempt,
  MissionCellSnapshot,
  MissionState,
} from "./types";

/** Session hook name registered by the plugin. */
export const COMPACTION_HOOK_NAME = "compaction" as const;

/** Hard ceiling of the contribution, measured with `Buffer.byteLength`. */
export const MAX_FACTS_BYTES = 8192;

/** Default number of cell lines before truncation. */
export const MAX_CELL_LINES = 25;

/** Default number of ready-cell lines before truncation. */
export const MAX_READY_LINES = 10;

/** Default number of characters kept from a cell title. */
export const MAX_TITLE_CHARS = 60;

const MAX_ID_CHARS = 64;
const MAX_AGENT_CHARS = 48;
const OPENING_TAG = "<swarmx_facts>";
const CLOSING_TAG = "</swarmx_facts>";

/** Text to push onto `event.system` as `{ type: "text", text }`. */
export interface CompactionContribution {
  readonly text: string;
}

/**
 * Optional factual sources for the builder.
 *
 * Everything here is already-loaded data: the builder never reads storage.
 * `pendingOrphans` is the count of `pending` ledger entries (see
 * `selectPendingOrphans`); absent cells are derived from the ledger.
 */
export interface CompactionOptions {
  readonly cells?: readonly MissionCellSnapshot[];
  readonly attempts?: readonly DispatchAttempt[];
  readonly assignments?: Readonly<Record<string, string>>;
  readonly pendingOrphans?: number;
  /** Line ceiling override (the byte ceiling is absolute). */
  readonly maxCells?: number;
  readonly maxReadyCells?: number;
  readonly maxTitleChars?: number;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
const SECRET_ASSIGNMENT =
  /\b(token|password|passwd|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return `${value.slice(0, maxChars - 3)}...`;
}

/**
 * Collapses whitespace/control characters, redacts secret-shaped assignments
 * and truncates. Deterministic for a given input and ceiling.
 */
function sanitize(value: string, maxChars: number): string {
  const flat = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const redacted = flat.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[redacted]`);
  return truncate(redacted, maxChars);
}

function boundedCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function cellLine(cell: MissionCellSnapshot, maxTitleChars: number): string {
  const title = cell.title === undefined ? "" : sanitize(cell.title, maxTitleChars);
  const agent = cell.agent === undefined ? "unassigned" : sanitize(cell.agent, MAX_AGENT_CHARS);
  return (
    `- id=${sanitize(cell.id, MAX_ID_CHARS)}` +
    ` title="${title}"` +
    ` status=${cell.status ?? "pending"}` +
    ` agent=${agent}` +
    ` attempts=${boundedCount(cell.attempts)}`
  );
}

function readyLine(cell: MissionCellSnapshot, maxTitleChars: number): string {
  const title = cell.title === undefined ? "" : sanitize(cell.title, maxTitleChars);
  const agent = cell.agent === undefined ? "unassigned" : sanitize(cell.agent, MAX_AGENT_CHARS);
  return (
    `- id=${sanitize(cell.id, MAX_ID_CHARS)}` +
    ` title="${title}"` +
    ` agent=${agent}` +
    ` attempts=${boundedCount(cell.attempts)}`
  );
}

function wrap(lines: readonly string[]): string {
  return [OPENING_TAG, ...lines, CLOSING_TAG].join("\n");
}

/** Last-resort clamp used only when even the header cannot fit the ceiling. */
function hardCap(text: string, cap: number): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  const room = Math.max(0, cap - Buffer.byteLength(CLOSING_TAG, "utf8"));
  const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${head}${CLOSING_TAG}`;
}

/**
 * Appends the invariant tail, then drops trailing body lines until the whole
 * text fits the byte ceiling. The omission marker is recomputed each round so
 * the result is deterministic for a given input.
 */
function fitWithinCap(body: readonly string[], tail: readonly string[], cap = MAX_FACTS_BYTES): string {
  const kept = [...body];
  let omitted = 0;
  for (;;) {
    const notice = omitted === 0 ? [] : [`truncated=${omitted} lines omitted`];
    const text = wrap([...kept, ...notice, ...tail]);
    if (Buffer.byteLength(text, "utf8") <= cap) return text;
    if (kept.length === 0) return hardCap(text, cap);
    kept.pop();
    omitted += 1;
  }
}

/**
 * Builds the compaction text from mission state.
 *
 * @param state - persisted mission state (`undefined` = no mission document).
 * @param opts - already-loaded ledger/assignment/cell snapshot.
 * @returns The contribution, or `undefined` when there is no active mission
 * (strict no-op: the host then compacts normally).
 */
export function buildCompactionContribution(
  state: MissionState | undefined,
  opts: CompactionOptions = {},
): CompactionContribution | undefined {
  const summary = selectMissionSummary(state);
  if (summary === undefined || !summary.active) return undefined;

  const maxCells = boundedCount(opts.maxCells ?? MAX_CELL_LINES);
  const maxReadyCells = boundedCount(opts.maxReadyCells ?? MAX_READY_LINES);
  const maxTitleChars = Math.max(1, boundedCount(opts.maxTitleChars ?? MAX_TITLE_CHARS));

  const cells = selectCells({
    state,
    attempts: opts.attempts ?? [],
    assignments: opts.assignments ?? {},
    cells: opts.cells ?? [],
  });
  const ready = selectReadyCells(cells);
  const shownCells = cells.slice(0, maxCells);
  const shownReady = ready.slice(0, maxReadyCells);

  const attemptsByCell = summary.counts.attemptsByCell;
  const attemptPairs = shownCells.map(
    (cell) => `${cell.id}:${boundedCount(attemptsByCell[cell.id] ?? cell.attempts)}`,
  );

  const body: string[] = [
    `mode=${summary.mode} active=${summary.active}`,
    `budget maxSpawns=${summary.budget.maxSpawns} maxIterations=${summary.budget.maxIterations} ` +
      `workerShare=${summary.workerShare.toFixed(2)}`,
    `counts spawns=${summary.counts.spawns} cells=${summary.counts.cells} ` +
      `workerSpawns=${summary.counts.workerSpawns}`,
    attemptPairs.length === 0 ? "attemptsByCell=-" : `attemptsByCell=${attemptPairs.join(",")}`,
    `cells=${cells.length} shown=${shownCells.length}`,
  ];
  for (const cell of shownCells) body.push(cellLine(cell, maxTitleChars));
  body.push(`ready=${ready.length} shown=${shownReady.length}`);
  for (const cell of shownReady) body.push(readyLine(cell, maxTitleChars));

  const invariants = [
    `invariants remainingSpawns=${summary.remainingSpawns}`,
    `remainingIterations=${summary.remainingIterations}`,
    `pendingOrphans=${boundedCount(opts.pendingOrphans)}`,
  ].join(" ");

  return { text: fitWithinCap(body, [invariants]) };
}
