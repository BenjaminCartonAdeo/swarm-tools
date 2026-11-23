/**
 * Deterministic roster resolution and subtask prompt rendering (Task 5).
 *
 * Resolution is deliberately explainable and free of silent fallbacks:
 *
 *   - only visible, non-primary agents are dispatchable;
 *   - title words (whole words, accents/case folded) score against agent
 *     descriptions;
 *   - file extensions add a hard technology prior;
 *   - the generic `swarm-worker` agent can only win through a real score, i.e.
 *     an explicit mechanical keyword — never by default;
 *   - a tie (or a zero score) returns `agent: null` plus arbitration data
 *     instead of guessing.
 *
 * `renderSubtaskPrompt` is pure: identical inputs always produce identical
 * output, the cell marker appears exactly once and the worker protocol appears
 * exactly once — a missing protocol resolves to the fail-closed fallback, a
 * duplicated one is normalized.
 */

import type { RetryRootCause } from "./types";

/** Agent fields used for resolution (subset of `Agent.Info`). */
export interface RosterAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
}

/** Minimal cell shape accepted by the resolver. */
export interface ResolveCell {
  readonly title: string;
  readonly files?: readonly string[];
}

/** Outcome of {@link resolveAgent}. */
export interface ResolveResult {
  /** Resolved agent id, or `null` when arbitration is required. */
  readonly agent: string | null;
  /** Human-readable explanation (never a raw prompt). */
  readonly rationale: string;
  /** True when no agent can be chosen without a human/model decision. */
  readonly needs_arbitration: boolean;
  /** Sorted agent ids tied at the top score (empty when a single winner exists). */
  readonly candidates: string[];
}

/** Input accepted by {@link renderSubtaskPrompt}. */
export interface RenderPromptInput {
  readonly cellID: string;
  readonly epicID: string;
  readonly agent: string;
  readonly title: string;
  readonly description: string;
  readonly files: readonly string[];
  readonly sharedContext?: string;
  readonly protocol?: string;
}

/** Explicit failure for an invalid prompt request (empty required field). */
export class RenderPromptError extends Error {
  readonly field: string;

  /**
   * @param field - offending input field (`description`, `files`, `cellID`, …).
   * @param detail - actionable expectation.
   */
  constructor(field: string, detail: string) {
    super(`swarmx subtask prompt refused [${field}]: ${detail}`);
    this.name = "RenderPromptError";
    this.field = field;
  }
}

/** Default id of the generic mechanical worker. */
export const SWARM_WORKER_AGENT_ID = "swarm-worker";

/**
 * Fail-closed worker protocol, used when the host cannot supply the
 * `swarm-worker-protocol` skill text. The worker is told to load the skill or
 * stop — never to proceed unguarded.
 */
export const WORKER_PROTOCOL_FALLBACK =
  "Load the swarm-worker-protocol skill before work. If it is unavailable, stop and report the blocker.";

/** Technology priors: file evidence is stronger than a title word. */
const TECH_BONUS = 10;
/** Score granted to the mechanical worker when a mechanical verb is present. */
const MECHANICAL_BONUS = 3;

const MECHANICAL_WORDS: ReadonlySet<string> = new Set([
  "mecanique",
  "mechanical",
  "rename",
  "renaming",
  "boilerplate",
  "move",
  "moving",
]);

interface TechHint {
  readonly test: (file: string) => boolean;
  /** Accepted agent ids/names, in preference order (scoring is id-based). */
  readonly agents: readonly string[];
}

/**
 * Extension/directory priors. A prior is not a gate: when the hinted agent is
 * absent from the roster the cell simply falls back to lexical score, then to
 * arbitration — it never rejects and never defaults to `swarm-worker`.
 */
const TECH_HINTS: readonly TechHint[] = [
  {
    test: (file) => /(^|\/)(tests?|specs?|__tests__)\//i.test(file),
    agents: ["test-automator", "qa-expert"],
  },
  {
    test: (file) => /\.spec\.[tj]sx?$/i.test(file) || /\.test\.[tj]sx?$/i.test(file),
    agents: ["test-automator", "qa-expert"],
  },
  { test: (file) => /\.tsx?$/i.test(file), agents: ["typescript-pro"] },
  { test: (file) => /\.jsx?$/i.test(file) || /\.mjs$/i.test(file), agents: ["typescript-pro", "frontend-developer"] },
  { test: (file) => /\.vue$/i.test(file), agents: ["vue", "vue-pro", "frontend-developer"] },
  { test: (file) => /\.py$/i.test(file), agents: ["python-pro", "python-coder"] },
  { test: (file) => /\.java$/i.test(file), agents: ["java-pro", "sdp-java-developer"] },
  { test: (file) => /\.sql$/i.test(file), agents: ["database-optimizer", "postgresql-pglite-pro"] },
  { test: (file) => /\.agent\.md$/i.test(file), agents: ["prompt-engineer"] },
  { test: (file) => /(^|\/)agents\//i.test(file) && /\.md$/i.test(file), agents: ["prompt-engineer"] },
  { test: (file) => /\.md$/i.test(file) && /(^|\/)(docs?|documentation)\//i.test(file), agents: ["documentation-expert"] },
  { test: (file) => /\.md$/i.test(file), agents: ["documentation-expert", "prompt-engineer"] },
  { test: (file) => /apm\.ya?ml$/i.test(file) || /(^|\/)packages\/.*\.ya?ml$/i.test(file), agents: ["prompt-engineer"] },
];

/** Locale-independent comparison so ordering never depends on the host. */
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Folds case and diacritics (NFKD + combining-mark removal). */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Whole words only: "vue" never matches "revue". */
function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9+#]+/)
    .filter((token) => token.length >= 3);
}

/** Canonical id segment: `development/typescript-pro` → `typescript-pro`. */
function normalizeId(value: string): string {
  const trimmed = fold(value.trim());
  const segment = trimmed.split("/").pop();
  return segment === undefined || segment.length === 0 ? trimmed : segment;
}

/** Recognizes the generic worker by V2 ID or its final path segment. */
export function isSwarmWorkerAgentID(agentID: string): boolean {
  return normalizeId(agentID) === SWARM_WORKER_AGENT_ID;
}

/** Every identity an agent answers to (id and name, last segment only). */
function agentKeys(agent: RosterAgent): ReadonlySet<string> {
  return new Set([normalizeId(agent.id), normalizeId(agent.name)]);
}

/** Technology targets hinted by the cell files. */
function techTargets(files: readonly string[]): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const file of files) {
    for (const hint of TECH_HINTS) {
      // First (highest priority) hint wins per file: a file under `tests/` is a
      // testing artifact even when it also carries a source extension.
      if (!hint.test(file)) continue;
      for (const agent of hint.agents) targets.add(normalizeId(agent));
      break;
    }
  }
  return targets;
}

/**
 * Lists the agents a subtask can be dispatched to.
 *
 * Hidden agents and primaries are excluded; the result is sorted by id so two
 * reads of the same roster always compare equal.
 *
 * @param agents - roster from `ctx.agent.list()`.
 * @returns Dispatchable agents, stable-sorted by id.
 */
export function listRoster(agents: readonly RosterAgent[]): RosterAgent[] {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "primary")
    .slice()
    .sort((left, right) => compareIds(left.id, right.id));
}

interface ScoredAgent {
  readonly agent: RosterAgent;
  readonly score: number;
}

function scoreAgent(
  agent: RosterAgent,
  titleTokens: ReadonlySet<string>,
  targets: ReadonlySet<string>,
  mechanical: boolean,
  workerID: string,
): number {
  const descriptionTokens = new Set(tokenize(agent.description ?? ""));
  let score = 0;
  for (const token of titleTokens) {
    if (descriptionTokens.has(token)) score += 1;
  }
  const keys = agentKeys(agent);
  for (const target of targets) {
    if (keys.has(target)) {
      score += TECH_BONUS;
      break;
    }
  }
  if (mechanical && keys.has(normalizeId(workerID))) score += MECHANICAL_BONUS;
  return score;
}

function describeTargets(targets: ReadonlySet<string>): string {
  return targets.size === 0 ? "none" : [...targets].sort().join(", ");
}

/**
 * Resolves one agent for a cell.
 *
 * @param cell - cell title plus optional file paths.
 * @param roster - roster from `ctx.agent.list()`.
 * @param workerID - mechanical worker id (defaults to `swarm-worker`).
 * @returns Winner, or `agent: null` plus arbitration data. Never falls back.
 */
export function resolveAgent(
  cell: ResolveCell,
  roster: readonly RosterAgent[],
  workerID: string = SWARM_WORKER_AGENT_ID,
): ResolveResult {
  const pool = listRoster(roster);
  if (pool.length === 0) {
    return {
      agent: null,
      rationale: "no dispatchable agent in the roster (hidden and primary agents are excluded)",
      needs_arbitration: true,
      candidates: [],
    };
  }

  const titleTokens = new Set(tokenize(cell.title ?? ""));
  const targets = techTargets(cell.files ?? []);
  const mechanical = [...titleTokens].some((token) => MECHANICAL_WORDS.has(token));

  const scored: ScoredAgent[] = pool
    .map((agent) => ({
      agent,
      score: scoreAgent(agent, titleTokens, targets, mechanical, workerID),
    }))
    .sort((left, right) =>
      left.score === right.score
        ? compareIds(left.agent.id, right.agent.id)
        : right.score - left.score,
    );

  const topScore = scored[0]?.score ?? 0;
  if (topScore <= 0) {
    // No roster agent matched. If tech targets suggest a specialized agent that
    // is NOT in the roster, surface it as a candidate so the coordinator can
    // register/assign it instead of silently falling back to `medium`.
    const suggested = [...targets].sort();
    return {
      agent: null,
      rationale: `no roster agent matched title words or technology hints (tech hints: ${describeTargets(targets)}). Suggested specialized agent(s): ${suggested.length > 0 ? suggested.join(", ") : "none detected"}`,
      needs_arbitration: true,
      candidates: suggested,
    };
  }

  const tied = scored.filter((entry) => entry.score === topScore);
  if (tied.length > 1) {
    const candidates = tied.map((entry) => entry.agent.id).sort(compareIds);
    return {
      agent: null,
      rationale: `ambiguous: ${candidates.join(", ")} all score ${topScore} — arbitration required`,
      needs_arbitration: true,
      candidates,
    };
  }

  const winner = tied[0].agent;
  const techMatch = [...targets].some((target) => agentKeys(winner).has(target));
  return {
    agent: winner.id,
    rationale: `${winner.id} (score ${topScore}${techMatch ? ", technology hint" : ""}${mechanical ? ", mechanical keyword" : ""})`,
    needs_arbitration: false,
    candidates: [],
  };
}

/** Attribute-level marker syntax (also used to deduplicate existing markers). */
const MARKER_PATTERN = /<!--\s*swarmx:cell=[^<>]*?-->/gi;

/** Safe marker id: no whitespace, separator or tag delimiter. */
const SAFE_ID = /^[^\s;<>]+$/;

function stripMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, "");
}

/** Keeps the first occurrence of `needle`, drops every later one. */
function dedupeOccurrences(text: string, needle: string): string {
  const first = text.indexOf(needle);
  if (first === -1) return text;
  const end = first + needle.length;
  return text.slice(0, end) + text.slice(end).split(needle).join("");
}

/** Number of non-overlapping `needle` occurrences in `text`. */
export function countOccurrences(text: string, needle: string): number {
  return needle.length === 0 ? 0 : text.split(needle).length - 1;
}

/**
 * Normalizes the worker protocol.
 *
 * Absent or blank input resolves to {@link WORKER_PROTOCOL_FALLBACK}, so the
 * rendered prompt can never silently omit the worker guardrails.
 */
export function resolveWorkerProtocol(protocol?: string): string {
  const cleaned = stripMarkers(protocol ?? "").trim();
  return cleaned.length === 0 ? WORKER_PROTOCOL_FALLBACK : cleaned;
}

function requireId(field: "cellID" | "epicID", value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RenderPromptError(field, `${field} must be a non-empty string`);
  }
  if (!SAFE_ID.test(trimmed)) {
    throw new RenderPromptError(field, `${field} must not contain whitespace, ';', '<' or '>'`);
  }
  return trimmed;
}

function requireText(field: "description", value: string): string {
  const stripped = stripMarkers(value).trim();
  if (stripped.length === 0) {
    throw new RenderPromptError(field, "description must be a non-empty string");
  }
  return stripped;
}

function requireFiles(files: readonly string[]): string[] {
  const cleaned = files.map((file) => file.trim()).filter((file) => file.length > 0);
  if (cleaned.length === 0) {
    throw new RenderPromptError("files", "files must list at least one non-empty path");
  }
  return cleaned;
}

/**
 * Renders the deterministic prompt handed to a dispatched agent.
 *
 * The exact marker `<!-- swarmx:cell=<cellID>; epic=<epicID> -->` is written
 * exactly once (any pre-existing marker is removed first), and the worker
 * protocol appears exactly once: a missing protocol resolves to
 * {@link WORKER_PROTOCOL_FALLBACK}, duplicates across title, description and
 * shared context collapse to a single occurrence.
 *
 * @throws RenderPromptError when `description`, `files`, `cellID` or `epicID`
 * is empty.
 */
export function renderSubtaskPrompt(input: RenderPromptInput): string {
  const cellID = requireId("cellID", input.cellID);
  const epicID = requireId("epicID", input.epicID);
  const protocol = resolveWorkerProtocol(input.protocol);
  let protocolPlaced = false;
  /** Keeps at most one protocol occurrence, in reading order. */
  const claimProtocol = (text: string): string => {
    if (!text.includes(protocol)) return text;
    if (protocolPlaced) return text.split(protocol).join("").trim();
    protocolPlaced = true;
    const end = text.indexOf(protocol) + protocol.length;
    return text.slice(0, end) + text.slice(end).split(protocol).join("");
  };

  const title = claimProtocol(input.title.trim());
  const description = claimProtocol(requireText("description", input.description));
  const files = requireFiles(input.files);
  const agent = input.agent.trim();
  const shared = claimProtocol(stripMarkers(input.sharedContext ?? "").trim());

  const sections: string[] = [
    `<!-- swarmx:cell=${cellID}; epic=${epicID} -->`,
    title.length === 0 ? `# Subtask ${cellID}` : `# Subtask ${cellID}: ${title}`,
    `Agent: ${agent}`,
    "",
    description,
    "",
    "Files:",
    ...files.map((file) => `- ${file}`),
  ];

  if (shared.length > 0) {
    sections.push("", "Shared context:", shared);
  }
  if (!protocolPlaced) {
    sections.push("", "Protocol:", protocol);
  }

  return sections.join("\n");
}

/** Argument names carrying the required root cause of a failed attempt. */
export const RETRY_CAUSE_FIELDS = ["failure_reason", "failed_command", "error_excerpt"] as const;

export type RetryCauseField = (typeof RETRY_CAUSE_FIELDS)[number];

/** Explicit failure for a retry requested without any root cause. */
export class RetryCauseError extends Error {
  /** Offending field, used by the caller to build a machine-readable error. */
  readonly field = "retry_cause" as const;

  constructor() {
    super(
      "swarmx retry refused [retry_cause]: provide failure_reason, failed_command or error_excerpt " +
        "so the retry fixes the cause instead of repeating the failure",
    );
    this.name = "RetryCauseError";
  }
}

const RETRY_CAUSE_KEYS: Readonly<Record<RetryCauseField, keyof RetryRootCause>> = {
  failure_reason: "failureReason",
  failed_command: "failedCommand",
  error_excerpt: "errorExcerpt",
};

/**
 * Extracts the root-cause payload from retry arguments.
 *
 * Every provided field must be a non-empty string; at least one is required.
 *
 * @throws RetryCauseError when the payload is missing or made only of blanks.
 */
export function parseRetryRootCause(args: Record<string, unknown>): RetryRootCause {
  const cause: { failureReason?: string; failedCommand?: string; errorExcerpt?: string } = {};
  let found = false;
  for (const field of RETRY_CAUSE_FIELDS) {
    const raw = args[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      throw new RetryCauseError();
    }
    const cleaned = stripMarkers(raw).trim();
    if (cleaned.length === 0) {
      throw new RetryCauseError();
    }
    cause[RETRY_CAUSE_KEYS[field]] = cleaned;
    found = true;
  }
  if (!found) throw new RetryCauseError();
  return cause;
}

/**
 * Renders the root-cause section prepended to a retry prompt.
 *
 * Pure and deterministic: only the fields present in `cause` appear.
 */
export function renderRetryRootCause(cause: RetryRootCause): string {
  const lines = [
    "## ROOT CAUSE (from the failed attempt)",
    "",
    "The previous attempt failed for the reason below. Fix the cause, not just the symptom.",
  ];
  if (cause.failureReason !== undefined) {
    lines.push("", `**Failure reason**: ${cause.failureReason}`);
  }
  if (cause.failedCommand !== undefined) {
    lines.push("", "**Failed command**:", "", "```sh", cause.failedCommand, "```");
  }
  if (cause.errorExcerpt !== undefined) {
    lines.push("", "**Error excerpt**:", "", "```text", cause.errorExcerpt, "```");
  }
  return lines.join("\n");
}

