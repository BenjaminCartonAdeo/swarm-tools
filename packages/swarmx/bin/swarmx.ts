#!/usr/bin/env node
/**
 * swarmx — installer/upgrader for the swarmx OpenCode assets.
 *
 * Commands:
 *   install   [--global] [--target <dir>] [--json]
 *   upgrade   [--global] [--target <dir>] [--json]
 *   doctor    [--target <dir>] [--json]
 *   uninstall [--global] [--target <dir>] [--json]
 *
 * Assets (agents, command, skills) are copied from the package's `assets/`
 * directory into the target `.opencode` directory. A manifest records the
 * installed version and the sha256 hash of every managed file so that
 * `upgrade`, `doctor` and `uninstall` can act only on managed assets.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallOptions {
  target?: string;
  targetDir?: string;
  dir?: string;
  path?: string;
  destination?: string;
  global?: boolean;
  assetsDir?: string;
  cwd?: string;
  version?: string;
}

export interface CommandResult {
  ok: boolean;
  command: string;
  target: string;
  version: string;
  scope: "project" | "global";
  message?: string;
  files?: string[];
  updated?: string[];
  removed?: string[];
  issues?: string[];
}

export interface Manifest {
  version: string;
  installedAt: string;
  scope: "project" | "global";
  assets: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function candidateAssetDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.SWARMX_ASSETS_DIR) dirs.push(process.env.SWARMX_ASSETS_DIR);
  // source layout: packages/swarmx/bin/swarmx.ts
  dirs.push(join(__dirname, "..", "assets"));
  // built layout: packages/swarmx/dist/bin/swarmx.js
  dirs.push(join(__dirname, "..", "..", "assets"));
  dirs.push(join(__dirname, "..", "..", "..", "assets"));
  // cwd fallbacks
  dirs.push(join(process.cwd(), "assets"));
  dirs.push(join(process.cwd(), "packages", "swarmx", "assets"));
  return dirs;
}

export function resolveAssetsDir(): string {
  for (const candidate of candidateAssetDirs()) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return resolve(candidate);
    }
  }
  throw new Error("swarmx: could not locate assets directory");
}

function candidatePackageRoots(): string[] {
  const roots: string[] = [];
  if (process.env.SWARMX_PACKAGE_ROOT) roots.push(process.env.SWARMX_PACKAGE_ROOT);
  roots.push(join(__dirname, ".."));
  roots.push(join(__dirname, "..", ".."));
  roots.push(join(__dirname, "..", "..", ".."));
  roots.push(join(process.cwd(), "packages", "swarmx"));
  roots.push(process.cwd());
  return roots;
}

export function resolveVersion(): string {
  for (const root of candidatePackageRoots()) {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.version && (pkg.name === "@benjamin/swarmx" || pkg.name === "swarmx")) {
          return pkg.version;
        }
      } catch {
        // ignore
      }
    }
  }
  // fallback: any package.json with version
  for (const root of candidatePackageRoots()) {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // ignore
      }
    }
  }
  return "0.1.0";
}

export function resolveTargetDir(opts: InstallOptions = {}): string {
  const t = opts.target ?? opts.targetDir ?? opts.dir ?? opts.path ?? opts.destination;
  if (t) return resolve(t);
  if (process.env.SWARMX_TARGET) return resolve(process.env.SWARMX_TARGET);
  const cwd = opts.cwd ?? process.cwd();
  if (opts.global) {
    const home = homedir();
    const configDir = join(home, ".config", "opencode");
    if (existsSync(configDir)) return resolve(configDir);
    const legacy = join(home, ".opencode");
    return resolve(legacy);
  }
  const base = basename(cwd);
  if (base === ".opencode") return resolve(cwd);
  const nested = join(cwd, ".opencode");
  if (existsSync(nested)) return resolve(nested);
  return resolve(nested);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  const hex = createHash("sha256").update(buf).digest("hex");
  return `sha256-${hex}`;
}

export function sha256Buffer(buf: Buffer): string {
  return `sha256-${createHash("sha256").update(buf).digest("hex")}`;
}

function listFilesRecursive(root: string, current: string = root): string[] {
  const out: string[] = [];
  if (!existsSync(current)) return out;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(root, full));
    } else if (entry.isFile()) {
      out.push(relativePath(root, full));
    }
  }
  return out.sort();
}

function relativePath(root: string, full: string): string {
  return full.slice(root.length + 1).split("\\").join("/");
}

function resolvePluginBundle(): string {
  const candidates = [
    join(__dirname, "..", "index.js"),
    join(__dirname, "..", "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("swarmx: could not locate plugin bundle");
}

export function listAssetFiles(assetsDir?: string): string[] {
  const root = assetsDir ?? resolveAssetsDir();
  const groups = ["agents", "commands", "skills"];
  const files: string[] = [];
  for (const group of groups) {
    const dir = join(root, group);
    files.push(...listFilesRecursive(dir).map((p) => `${group}/${p}`));
  }
  return [...new Set(files)].sort();
}

function readManifest(target: string): Manifest | undefined {
  const path = join(target, ".swarmx", "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

function writeManifest(target: string, manifest: Manifest): void {
  const dir = join(target, ".swarmx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function backupFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, "");
  const backup = `${filePath}.swarmx-backup-${ts}`;
  writeFileSync(backup, readFileSync(filePath));
  return backup;
}

function removeEmptyDirs(dir: string, stopAt: string): void {
  let current = dir;
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      if (readdirSync(current).length === 0) {
        rmSync(current, { recursive: false, force: true });
        current = dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export async function install(opts: InstallOptions = {}): Promise<CommandResult> {
  const target = resolveTargetDir(opts);
  const assetsDir = opts.assetsDir ?? resolveAssetsDir();
  const version = opts.version ?? resolveVersion();
  const scope: "project" | "global" = opts.global ? "global" : "project";
  const files = listAssetFiles(assetsDir);

  mkdirSync(target, { recursive: true });

  const copied: string[] = [];
  for (const rel of files) {
    const src = join(assetsDir, rel);
    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) {
      const srcHash = sha256File(src);
      const destHash = sha256File(dest);
      if (srcHash !== destHash) {
        backupFile(dest);
      }
    }
    copyFileSync(src, dest);
    copied.push(rel);
  }

  const assets: Record<string, string> = {};
  for (const rel of files) {
    assets[rel] = sha256File(join(target, rel));
  }
  const pluginDest = join(target, "plugins", "swarmx.js");
  mkdirSync(dirname(pluginDest), { recursive: true });
  copyFileSync(resolvePluginBundle(), pluginDest);
  assets["plugins/swarmx.js"] = sha256File(pluginDest);

  const manifest: Manifest = {
    version,
    installedAt: new Date().toISOString(),
    scope,
    assets,
  };
  writeManifest(target, manifest);

  return {
    ok: true,
    command: "install",
    target,
    version,
    scope,
    message: `Installed ${Object.keys(assets).length} assets`,
    files: copied,
  };
}

export async function upgrade(opts: InstallOptions = {}): Promise<CommandResult> {
  const target = resolveTargetDir(opts);
  const assetsDir = opts.assetsDir ?? resolveAssetsDir();
  const version = opts.version ?? resolveVersion();
  const scope: "project" | "global" = opts.global ? "global" : "project";
  const files = listAssetFiles(assetsDir);

  const existing = readManifest(target);
  if (!existing) {
    const result = await install({ ...opts, target, assetsDir, version, global: opts.global });
    return { ...result, command: "upgrade", message: "No manifest found; performed install" };
  }

  const updated: string[] = [];
  for (const rel of files) {
    const src = join(assetsDir, rel);
    const dest = join(target, rel);
    const srcHash = sha256File(src);
    mkdirSync(dirname(dest), { recursive: true });

    let needsUpdate = false;
    if (!existsSync(dest)) needsUpdate = true;
    else {
      const destHash = sha256File(dest);
      const manifestHash = existing.assets[rel];
      if (destHash !== srcHash) needsUpdate = true;
      if (manifestHash !== srcHash) needsUpdate = true;
    }

    if (needsUpdate) {
      if (existsSync(dest)) backupFile(dest);
      copyFileSync(src, dest);
      updated.push(rel);
    }
  }

  const assets: Record<string, string> = {};
  for (const rel of files) {
    const dest = join(target, rel);
    if (existsSync(dest)) assets[rel] = sha256File(dest);
  }
  const pluginDest = join(target, "plugins", "swarmx.js");
  mkdirSync(dirname(pluginDest), { recursive: true });
  const pluginSrc = resolvePluginBundle();
  if (!existsSync(pluginDest) || sha256File(pluginDest) !== sha256File(pluginSrc)) {
    if (existsSync(pluginDest)) backupFile(pluginDest);
    copyFileSync(pluginSrc, pluginDest);
    updated.push("plugins/swarmx.js");
  }
  assets["plugins/swarmx.js"] = sha256File(pluginDest);

  const manifest: Manifest = {
    version,
    installedAt: new Date().toISOString(),
    scope,
    assets,
  };
  writeManifest(target, manifest);

  return {
    ok: true,
    command: "upgrade",
    target,
    version,
    scope,
    message: `Updated ${updated.length} assets`,
    updated,
    files: files,
  };
}

export interface DoctorIssue {
  level: "error" | "warn";
  message: string;
}

export async function doctor(opts: InstallOptions = {}): Promise<CommandResult & { issues: string[] }> {
  const target = resolveTargetDir(opts);
  const assetsDir = opts.assetsDir ?? resolveAssetsDir();
  const version = opts.version ?? resolveVersion();
  const files = listAssetFiles(assetsDir);
  const expected = [...files, "plugins/swarmx.js"];

  const issues: string[] = [];

  const manifest = readManifest(target);
  if (!manifest) {
    issues.push("manifest missing: .swarmx/manifest.json not found");
  } else {
    if (manifest.version !== version) {
      issues.push(`version mismatch: installed ${manifest.version}, package ${version}`);
    }
  }

  // Check every expected asset
  for (const rel of expected) {
    const dest = join(target, rel);
    const src = join(assetsDir, rel);
    if (!existsSync(dest)) {
      issues.push(`missing asset: ${rel}`);
      continue;
    }
    const destHash = sha256File(dest);
    const srcHash = existsSync(src) ? sha256File(src) : undefined;
    if (manifest) {
      const manifestHash = manifest.assets[rel];
      if (!manifestHash) {
        issues.push(`untracked asset: ${rel}`);
      } else if (manifestHash !== destHash) {
        issues.push(`modified asset: ${rel}`);
      }
    }
    if (srcHash !== undefined && srcHash !== destHash) {
      issues.push(`outdated asset: ${rel}`);
    }
  }

  // Check manifest entries not in source
  if (manifest) {
    for (const key of Object.keys(manifest.assets)) {
      if (!expected.includes(key)) {
        issues.push(`unknown managed asset in manifest: ${key}`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    command: "doctor",
    target,
    version,
    scope: (manifest?.scope ?? (opts.global ? "global" : "project")) as "project" | "global",
    message: issues.length === 0 ? "OK" : `${issues.length} issue(s) found`,
    issues,
    files,
  };
}

export async function uninstall(opts: InstallOptions = {}): Promise<CommandResult> {
  const target = resolveTargetDir(opts);
  const assetsDir = opts.assetsDir ?? resolveAssetsDir();
  const version = opts.version ?? resolveVersion();
  const files = listAssetFiles(assetsDir);

  const manifest = readManifest(target);
  const managed = manifest ? Object.keys(manifest.assets) : files;

  const removed: string[] = [];
  for (const rel of managed) {
    const dest = join(target, rel);
    if (existsSync(dest)) {
      rmSync(dest, { force: true });
      removed.push(rel);
      removeEmptyDirs(dirname(dest), target);
    }
  }

  // Remove manifest
  const manifestDir = join(target, ".swarmx");
  const manifestPath = join(manifestDir, "manifest.json");
  if (existsSync(manifestPath)) {
    rmSync(manifestPath, { force: true });
  }
  try {
    if (existsSync(manifestDir) && readdirSync(manifestDir).length === 0) {
      rmSync(manifestDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    command: "uninstall",
    target,
    version,
    scope: (manifest?.scope ?? (opts.global ? "global" : "project")) as "project" | "global",
    message: `Removed ${removed.length} assets`,
    removed,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string;
  global: boolean;
  target?: string;
  dir?: string;
  assetsDir?: string;
  version?: string;
  json: boolean;
  help: boolean;
  showVersion: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    global: false,
    json: false,
    help: false,
    showVersion: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--global" || arg === "-g") {
      parsed.global = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.showVersion = true;
    } else if (arg === "--target" || arg === "--dir" || arg === "--opencode-dir" || arg === "--target-dir" || arg === "--path" || arg === "-t") {
      parsed.target = argv[++i];
    } else if (arg === "--assets-dir") {
      parsed.assetsDir = argv[++i];
    } else if (arg === "--version-override") {
      parsed.version = argv[++i];
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg.startsWith("--dir=")) {
      parsed.dir = arg.slice("--dir=".length);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  if (positional.length > 0) parsed.command = positional[0];
  if (parsed.dir && !parsed.target) parsed.target = parsed.dir;
  return parsed;
}

function printHelp(): void {
  console.log(`swarmx — installer for swarmx OpenCode assets

Usage:
  swarmx <command> [options]

Commands:
  install     Copy assets into the target .opencode directory
  upgrade     Update changed assets based on the manifest
  doctor      Verify installed assets and manifest
  uninstall   Remove managed assets only

Lifecycle operator commands (CLI-only; exit 0 success, 1 refusal, 2 usage):
  recover [--project <p>] [--effect <id> | --feedback <op>] [--json]
              Recover stale effect/feedback claims; without --project it scans all projects
  unit revoke <unit-id> --expected-fence <n> --reason <reason> [--json]
              Fenced revoke of a RESERVED/BOUND/SUBMITTED WorkUnit
  mission force-close <mission-pk> --expected-fence <n> --owner-session <session-id> --reason <reason> [--json]
              Close a CLOSING mission whose live units have failed mandatory effects
  downgrade --project <p> --yes [--json]
              Request legacy downgrade; refuses while any mission is OPEN or CLOSING

Options:
  --global, -g            Use global OpenCode directory
  --target, --dir, -t     Target .opencode directory
  --assets-dir            Override assets directory (tests)
  --json                  JSON output
  --version, -v           Show version
  --help, -h              Show help
`);
}

// ---------------------------------------------------------------------------
// Lifecycle operator commands (CLI-only; never registered as agent tools)
//
//   recover   [--project <p>] [--effect <id> | --feedback <op>] [--json]
//   unit revoke <unit-id> --expected-fence <n> --reason <reason> [--json]
//   mission force-close <mission-pk> --expected-fence <n> --owner-session <session-id> --reason <reason> [--json]
//   downgrade --project <p> --yes [--json]
//
// Exit codes: 0 success, 1 refusal/error, 2 usage.
// ---------------------------------------------------------------------------

const LIFECYCLE_COMMANDS = new Set(["recover", "unit", "mission", "downgrade"]);

class UsageError extends Error {}

type LifecycleErrorCode =
  | "usage_error"
  | "live_mission"
  | "fence_conflict"
  | "forced_close_not_allowed"
  | "claim_conflict"
  | "not_found"
  | "illegal_transition"
  | "internal_error";

interface LifecycleFlags {
  positional: string[];
  values: Map<string, string>;
  bools: Set<string>;
  json: boolean;
}

function parseLifecycleFlags(argv: string[], valueFlags: string[], boolFlags: string[]): LifecycleFlags {
  const flags: LifecycleFlags = { positional: [], values: new Map(), bools: new Set(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") {
      flags.json = true;
    } else if (valueFlags.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} requires a value`);
      if (flags.values.has(arg)) throw new UsageError(`${arg} given twice`);
      flags.values.set(arg, value);
      i += 1;
    } else if (boolFlags.includes(arg)) {
      flags.bools.add(arg);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function lifecycleErrorCode(error: unknown): { code: LifecycleErrorCode; exit: number } {
  if (error instanceof UsageError) return { code: "usage_error", exit: 2 };
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "InvalidRevokeReasonError":
      return { code: "usage_error", exit: 2 };
    case "LiveMissionError":
      return { code: "live_mission", exit: 1 };
    case "FenceConflictError":
    case "MissionFenceConflictError":
      return { code: "fence_conflict", exit: 1 };
    case "ForcedCloseNotAllowedError":
      return { code: "forced_close_not_allowed", exit: 1 };
    case "EffectClaimConflictError":
      return { code: "claim_conflict", exit: 1 };
    case "EffectNotFoundError":
    case "WorkUnitNotFoundError":
    case "ReviewFeedbackNotFoundError":
      return { code: "not_found", exit: 1 };
    case "IllegalTransitionError":
      return { code: "illegal_transition", exit: 1 };
    default:
      return { code: "internal_error", exit: 1 };
  }
}

class ReviewFeedbackNotFoundError extends Error {
  constructor(operationId: string) {
    super(`No unfinished claimed feedback operation ${operationId}`);
    this.name = "ReviewFeedbackNotFoundError";
  }
}

async function openLifecycleDb() {
  const swarmMail = await import("swarm-mail");
  const { ensureWorkUnitSchema } = await import("../src/workunit/schema.js");
  const db = await swarmMail.getSwarmMailDatabaseAdapter();
  // Schema only: setupWorkUnitRuntime would auto-recover, which the operator controls here.
  await ensureWorkUnitSchema(db);
  return { db, swarmMail };
}

async function runRecover(flags: LifecycleFlags): Promise<Record<string, unknown>> {
  if (flags.positional.length > 1) throw new UsageError("recover takes no positional arguments");
  const project = flags.values.get("--project");
  const effectId = flags.values.get("--effect");
  const feedbackId = flags.values.get("--feedback");
  if (effectId !== undefined && feedbackId !== undefined) {
    throw new UsageError("--effect and --feedback are mutually exclusive");
  }
  const { db, swarmMail } = await openLifecycleDb();
  const effects = await import("../src/workunit/effects.js");
  const { isProcessAlive } = await import("../src/workunit/ports.js");
  const { getOrCreateHostInstanceId } = await import("../src/workunit/store.js");
  const host = hostname();
  const hostInstanceId = await getOrCreateHostInstanceId(db, host);

  const stale = await effects.recoverStaleEffects(db, {
    hostInstanceId, hostname: host, isProcessAlive, ...(project === undefined ? {} : { project }),
  });
  const feedback = await swarmMail.recoverStaleReviewFeedback(
    { hostname: host, isProcessAlive, ...(project === undefined ? {} : { projectKey: project }) },
    db,
  );
  const out: Record<string, unknown> = {
    recoveredEffects: stale.recoveredEffects,
    recoveredFeedback: feedback.recoveredOperations,
    foreignHostEffects: stale.foreignHostCandidates,
    foreignHostFeedback: feedback.foreignCandidates,
  };
  if (effectId !== undefined) {
    const token = await effects.readEffectClaimToken(db, effectId, project);
    if (token === undefined) throw new effects.EffectNotFoundError(effectId);
    if (token === null) throw new effects.EffectClaimConflictError(effectId);
    await effects.recoverEffectClaim(db, {
      effectId, expectedClaimToken: token, ...(project === undefined ? {} : { project }),
    });
    out.explicitEffect = effectId;
  }
  if (feedbackId !== undefined) {
    const released = await swarmMail.recoverReviewFeedbackOperation(feedbackId, db, project);
    if (!released) throw new ReviewFeedbackNotFoundError(feedbackId);
    out.explicitFeedback = feedbackId;
  }
  return out;
}

async function runUnitRevoke(flags: LifecycleFlags): Promise<Record<string, unknown>> {
  const [, sub, unitId, ...rest] = flags.positional;
  if (sub !== "revoke") throw new UsageError("Usage: swarmx unit revoke <unit-id> --expected-fence <n> --reason <reason>");
  if (unitId === undefined || rest.length > 0) throw new UsageError("unit revoke requires exactly one <unit-id>");
  const fenceRaw = flags.values.get("--expected-fence");
  if (fenceRaw === undefined || !/^\d+$/.test(fenceRaw)) throw new UsageError("--expected-fence <n> is required");
  const reason = flags.values.get("--reason");
  if (reason === undefined || reason.trim().length === 0) throw new UsageError("--reason <reason> is required and nonblank");
  const { db } = await openLifecycleDb();
  const { revokeWorkUnit } = await import("../src/workunit/store.js");
  const unit = await revokeWorkUnit(db, { unitId, expectedFence: Number(fenceRaw), reason });
  return { unitId: unit.id, state: "REVOKED", fence: Number(unit.fence), reason: unit.reason };
}

async function runMissionForceClose(flags: LifecycleFlags): Promise<Record<string, unknown>> {
  const usage = "Usage: swarmx mission force-close <mission-pk> --expected-fence <n> --owner-session <session-id> --reason <reason>";
  const [, sub, missionPk, ...rest] = flags.positional;
  if (sub !== "force-close") throw new UsageError(usage);
  if (missionPk === undefined || rest.length > 0) throw new UsageError("mission force-close requires exactly one <mission-pk>");
  const fenceRaw = flags.values.get("--expected-fence");
  if (fenceRaw === undefined || !/^\d+$/.test(fenceRaw)) throw new UsageError("--expected-fence <n> is required");
  const owner = flags.values.get("--owner-session");
  if (owner === undefined || owner.trim().length === 0) throw new UsageError("--owner-session <session-id> is required");
  const reason = flags.values.get("--reason")?.trim();
  if (reason === undefined || reason.length === 0) throw new UsageError("--reason <reason> is required and nonblank");
  const { db } = await openLifecycleDb();
  const { forceMissionClose } = await import("../src/workunit/effects.js");
  const mission = await forceMissionClose(db, { missionPk, expectedFence: Number(fenceRaw), ownerSessionId: owner });
  return { missionId: mission.id, state: mission.state, fence: Number(mission.fence), reason };
}

async function runDowngrade(flags: LifecycleFlags): Promise<Record<string, unknown>> {
  if (flags.positional.length > 1) throw new UsageError("downgrade takes no positional arguments");
  const project = flags.values.get("--project");
  if (project === undefined || project.length === 0) throw new UsageError("--project <project> is required");
  if (!flags.bools.has("--yes")) throw new UsageError("downgrade requires --yes");
  const { db } = await openLifecycleDb();
  const { requestDowngrade } = await import("../src/workunit/store.js");
  return requestDowngrade(db, project);
}

export async function runLifecycleCommand(argv: string[]): Promise<number> {
  let json = argv.includes("--json");
  try {
    const command = argv[0];
    let result: Record<string, unknown>;
    if (command === "recover") {
      const flags = parseLifecycleFlags(argv, ["--project", "--effect", "--feedback"], []);
      json = flags.json;
      result = await runRecover(flags);
    } else if (command === "unit") {
      const flags = parseLifecycleFlags(argv, ["--expected-fence", "--reason"], []);
      json = flags.json;
      result = await runUnitRevoke(flags);
    } else if (command === "mission") {
      const flags = parseLifecycleFlags(argv, ["--expected-fence", "--owner-session", "--reason"], []);
      json = flags.json;
      result = await runMissionForceClose(flags);
    } else {
      const flags = parseLifecycleFlags(argv, ["--project"], ["--yes"]);
      json = flags.json;
      result = await runDowngrade(flags);
    }
    console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const { code, exit } = lifecycleErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ error: { code, message } }));
    else console.error(`${code}: ${message}`);
    return exit;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] !== undefined && LIFECYCLE_COMMANDS.has(argv[0])) return runLifecycleCommand(argv);
  const parsed = parseArgs(argv);

  if (parsed.showVersion) {
    console.log(resolveVersion());
    return 0;
  }
  if (parsed.help || !parsed.command) {
    printHelp();
    return parsed.help ? 0 : 0;
  }

  const opts: InstallOptions = {
    global: parsed.global,
    target: parsed.target,
    assetsDir: parsed.assetsDir,
    version: parsed.version,
  };

  try {
    let result: CommandResult;
    switch (parsed.command) {
      case "install":
        result = await install(opts);
        break;
      case "upgrade":
        result = await upgrade(opts);
        break;
      case "doctor":
        result = await doctor(opts);
        break;
      case "uninstall":
        result = await uninstall(opts);
        break;
      default:
        console.error(`Unknown command: ${parsed.command}`);
        printHelp();
        return 2;
    }

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message ?? "OK");
      if (result.updated && result.updated.length > 0) {
        for (const f of result.updated) console.log(`  updated: ${f}`);
      }
      if (result.removed && result.removed.length > 0) {
        for (const f of result.removed) console.log(`  removed: ${f}`);
      }
      if (result.issues && result.issues.length > 0) {
        for (const issue of result.issues) console.log(`  - ${issue}`);
      }
    }

    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(message);
    }
    return 1;
  }
}


if (import.meta.main) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
