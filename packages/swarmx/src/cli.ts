/**
 * Robust, redacted adapter for the local `swarm` CLI.
 *
 * Contract highlights:
 *   - spawns `swarm tool <name> --json <args>` (binary overridable through
 *     `RunToolOptions.binary` or `$SWARMX_SWARM_BIN`);
 *   - never throws on a zero exit; parses tolerant leading JSON;
 *   - maps every failure mode to a typed {@link CliError} code;
 *   - caps cumulative stdout + stderr bytes and kills the child on overflow;
 *   - redacts secrets from every diagnostic and never writes logs to disk.
 *
 * No direct `effect` import: this module is plain Promise-based Node/Bun code.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { type CliErrorCode, type RunToolOptions, type SwarmCliRunner } from "./types";

export type { CliErrorCode, RunToolOptions, SwarmCliRunner } from "./types";

/** Binary used when neither `binary` nor `$SWARMX_SWARM_BIN` is set. */
export const DEFAULT_SWARM_BINARY = "swarm";

/** Environment variable overriding the `swarm` executable path. */
export const SWARMX_SWARM_BIN_ENV = "SWARMX_SWARM_BIN";

/** Default hard deadline for a single invocation. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default ceiling for cumulative stdout + stderr bytes. */
export const DEFAULT_MAX_BYTES = 1_000_000;

/** Version advertised in actionable "not found" diagnostics. */
const EXPECTED_SWARM_VERSION = "0.63.2";

/**
 * Typed CLI failure.
 *
 * `tool` identifies the backend tool (or the CLI sub-command) and `exitCode`
 * is populated only when the child actually exited with a code.
 */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly tool: string;
  readonly exitCode?: number;

  /**
   * @param code - machine-readable failure category.
   * @param tool - tool or sub-command that failed.
   * @param message - already-redacted, actionable human message.
   * @param exitCode - child exit status when available.
   */
  constructor(code: CliErrorCode, tool: string, message: string, exitCode?: number) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.tool = tool;
    if (exitCode !== undefined) {
      this.exitCode = exitCode;
    }
  }
}

interface ExecTarget {
  /** Value stored on {@link CliError.tool}. */
  readonly tool: string;
  /** Human label used in diagnostics, e.g. `tool hive_ready`. */
  readonly command: string;
}

interface RawResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Removes ANSI CSI/OSC sequences from CLI output. */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

const SENSITIVE_ASSIGNMENT =
  /(["']?)([A-Za-z0-9_.-]*(?:token|key|secret|password|authorization|bearer)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{6,}/g;
const GHP_TOKEN = /\bghp_[A-Za-z0-9]{6,}/g;

/**
 * Masks secret-looking values in a diagnostic string.
 *
 * Handles `key=value` / `key: value` forms for sensitive key names, `Bearer`
 * schemes and common provider token prefixes. Applied to every error message
 * and stderr excerpt; never applied to a successful payload.
 *
 * @param text - raw diagnostic text.
 * @returns the text with secret values replaced by `[REDACTED]`.
 */
export function redact(text: string): string {
  return text
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, (_match: string, quote: string, key: string, separator: string) => {
      return `${quote}${key}${quote}${separator}[REDACTED]`;
    })
    .replace(SK_TOKEN, "[REDACTED]")
    .replace(GHP_TOKEN, "[REDACTED]");
}

function invalidJsonError(tool: string, raw: string): CliError {
  const snippet = redact(raw.trim().slice(0, 400)).slice(0, 200);
  const suffix = snippet.length > 0 ? `: ${snippet}` : "";
  return new CliError("CliInvalidJson", tool, `swarm tool ${tool} returned invalid JSON${suffix}`);
}

/**
 * Extracts and parses the first balanced JSON object/array in `text`.
 *
 * ANSI sequences are stripped, banner noise before the payload is skipped and
 * trailing noise after the closing delimiter is ignored. Braces inside JSON
 * strings and escape sequences are respected.
 *
 * @param text - raw CLI stdout (possibly polluted by a banner).
 * @param tool - tool name used in the {@link CliError} when parsing fails.
 * @throws {@link CliError} with code `CliInvalidJson` when no valid JSON exists.
 */
export function parseLeadingJson(text: string, tool = DEFAULT_SWARM_BINARY): unknown {
  const clean = stripAnsi(text);
  let start = -1;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === "{" || char === "[") {
      start = index;
      break;
    }
  }

  if (start === -1) {
    throw invalidJsonError(tool, clean);
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < clean.length; index += 1) {
    const char = clean[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const opened = stack.pop();
      const mismatched =
        (char === "}" && opened !== "{") || (char === "]" && opened !== "[");
      if (mismatched) {
        throw invalidJsonError(tool, clean);
      }

      if (stack.length === 0) {
        const candidate = clean.slice(start, index + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          throw invalidJsonError(tool, clean);
        }
      }
    }
  }

  throw invalidJsonError(tool, clean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimally unwraps `{ok|success: boolean, data|result: payload}` envelopes.
 *
 * Unwrapping only happens when it cannot drop information: exactly one payload
 * key, exactly one boolean flag and no other keys. Everything else is returned
 * unchanged so no field is ever lost silently.
 */
function normalisePayload(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) {
    return parsed;
  }

  const keys = Object.keys(parsed);
  const payloadKeys = keys.filter((key) => key === "data" || key === "result");
  const flagKeys = keys.filter(
    (key) => (key === "ok" || key === "success") && typeof parsed[key] === "boolean",
  );
  const onlyKnownKeys = keys.every(
    (key) => key === "data" || key === "result" || key === "ok" || key === "success",
  );

  if (payloadKeys.length !== 1 || flagKeys.length !== 1 || !onlyKnownKeys) {
    return parsed;
  }

  return parsed[payloadKeys[0]];
}

function resolveBinary(opts: RunToolOptions): string {
  if (opts.binary !== undefined && opts.binary.length > 0) {
    return opts.binary;
  }

  const fromEnv = process.env[SWARMX_SWARM_BIN_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  return DEFAULT_SWARM_BINARY;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function spawnFailure(target: ExecTarget, binary: string, error: unknown): CliError {
  if (errorCode(error) === "ENOENT") {
    return new CliError(
      "CliNotFound",
      target.tool,
      redact(
        `swarm CLI introuvable ("${binary}") ; installe swarm ${EXPECTED_SWARM_VERSION} ou définis ${SWARMX_SWARM_BIN_ENV}`,
      ),
    );
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new CliError(
    "CliNonZero",
    target.tool,
    redact(`failed to spawn swarm CLI ("${binary}") for ${target.command}: ${detail}`),
  );
}

/**
 * Spawns the CLI with a byte cap, deadline and cancellation, returning raw text.
 *
 * @throws {@link CliError} for every failure mode (never for exit 0).
 */
function execSwarm(
  cliArgs: readonly string[],
  opts: RunToolOptions,
  target: ExecTarget,
): Promise<RawResult> {
  const binary = resolveBinary(opts);
  const timeoutMs = positiveLimit(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveLimit(opts.maxBytes, DEFAULT_MAX_BYTES);
  const signal = opts.signal;

  if (signal?.aborted) {
    return Promise.reject(new CliError("CliAborted", target.tool, redact(`swarm ${target.command} aborted by signal`)));
  }

  return new Promise<RawResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let child: ChildProcess;
    try {
      child = spawn(binary, [...cliArgs], {
        cwd: opts.cwd,
        env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(spawnFailure(target, binary, error));
      return;
    }

    function cleanup(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    }

    function finish(settle: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      settle();
    }

    function killChild(): void {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; nothing left to kill.
      }
    }

    function onAbort(): void {
      finish(() => {
        killChild();
        reject(
          new CliError(
            "CliAborted",
            target.tool,
            redact(`swarm ${target.command} aborted by signal (child killed)`),
          ),
        );
      });
    }

    function onTimeout(): void {
      finish(() => {
        killChild();
        reject(
          new CliError(
            "CliTimeout",
            target.tool,
            redact(`swarm ${target.command} timed out after ${timeoutMs}ms (child killed)`),
          ),
        );
      });
    }

    function collect(chunk: Buffer, sink: Buffer[]): void {
      if (settled) {
        return;
      }

      const remaining = maxBytes - totalBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) {
          sink.push(chunk.subarray(0, remaining));
        }
        totalBytes = maxBytes;
        finish(() => {
          killChild();
          reject(
            new CliError(
              "CliOutputTooLarge",
              target.tool,
              redact(`swarm ${target.command} output exceeded ${maxBytes} bytes (child killed)`),
            ),
          );
        });
        return;
      }

      sink.push(chunk);
      totalBytes += chunk.length;
    }

    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdoutChunks));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderrChunks));

    child.on("error", (error: Error) => {
      finish(() => reject(spawnFailure(target, binary, error)));
    });

    child.on("close", (code: number | null) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
        reject(
          new CliError(
            "CliNonZero",
            target.tool,
            redact(`swarm ${target.command} exited with code ${code ?? "unknown"}${detail}`),
            code ?? undefined,
          ),
        );
      });
    });

    timer = setTimeout(onTimeout, timeoutMs);

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }
  });
}

/**
 * Runs one backend tool and returns its parsed, minimally-normalised payload.
 *
 * @param name - CLI tool name, e.g. `"hive_ready"`.
 * @param args - arguments serialised as the `--json` payload.
 * @param opts - binary, cwd, cancellation, deadline, byte cap and env overrides.
 * @throws {@link CliError} for every documented failure mode.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  opts: RunToolOptions = {},
): Promise<unknown> {
  const target: ExecTarget = { tool: name, command: `tool ${name}` };
  const { stdout } = await execSwarm(
    ["tool", name, "--json", JSON.stringify(args)],
    opts,
    target,
  );

  return normalisePayload(parseLeadingJson(stdout, name));
}

/**
 * Lists backend tool names from `swarm tool --list`.
 *
 * Banner lines, category headers (e.g. `hive:`) and usage examples are ignored;
 * results are deduplicated and sorted.
 */
export async function listTools(opts: RunToolOptions = {}): Promise<string[]> {
  const target: ExecTarget = { tool: "tool --list", command: "tool --list" };
  const { stdout } = await execSwarm(["tool", "--list"], opts, target);
  const names = new Set<string>();

  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const candidate = line.trim();
    // Tool names are `namespace_tool` identifiers on their own line; the
    // namespace separator may be `_` or `-` (e.g. `semantic-memory_find`).
    // Category headers end with `:` and usage/example lines contain spaces.
    if (/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(candidate)) {
      names.add(candidate);
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Returns the semantic version reported by `swarm --version`.
 *
 * @throws {@link CliError} with code `CliInvalidJson` when no version is found.
 */
export async function version(opts: RunToolOptions = {}): Promise<string> {
  const target: ExecTarget = { tool: "--version", command: "--version" };
  const { stdout } = await execSwarm(["--version"], opts, target);
  const clean = stripAnsi(stdout);

  const preferred = /version\s*:?\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i.exec(clean);
  const fallback = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(clean);
  const match = preferred ?? fallback;

  if (match === null) {
    return Promise.reject(
      new CliError(
        "CliInvalidJson",
        target.tool,
        redact(`could not parse swarm version from output: ${clean.trim().slice(0, 200)}`),
      ),
    );
  }

  return match[1];
}

/**
 * Creates a runner that applies shared defaults to every invocation.
 *
 * @param defaults - binary, cwd, cancellation, deadline, cap and env defaults.
 */
export function createSwarmCliRunner(defaults: RunToolOptions = {}): SwarmCliRunner {
  return {
    runTool: (name, args, opts = {}) => runTool(name, args, { ...defaults, ...opts }),
    listTools: () => listTools(defaults),
    version: () => version(defaults),
  };
}
