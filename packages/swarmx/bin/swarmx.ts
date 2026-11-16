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
import { homedir } from "node:os";
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
    message: `Installed ${files.length} assets`,
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
  for (const rel of files) {
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
      if (!files.includes(key)) {
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

Options:
  --global, -g            Use global OpenCode directory
  --target, --dir, -t     Target .opencode directory
  --assets-dir            Override assets directory (tests)
  --json                  JSON output
  --version, -v           Show version
  --help, -h              Show help
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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
