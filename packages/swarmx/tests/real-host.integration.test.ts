/**
 * Real OpenCode V2 host integration test (Task 19).
 *
 * Starts the installed `opencode` binary as a private foreground server inside
 * an isolated temporary Git project, loads the BUILT swarmx plugin plus a probe
 * plugin by absolute path, and drives two prompts through a deterministic local
 * OpenAI-compatible model. The breaks this catches:
 *  - the built bundle no longer loads in the real host (plugin inactive);
 *  - `hive_ready` is no longer registered or no longer reaches the backend CLI;
 *  - host hook payload drift (`id`, session/agent/message fields, nested result);
 *  - swarmx hooks swallowing built-in tool hook cycles (`shell`).
 *
 * Skips only when the real host binary is unavailable.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { OpenCode } from "@opencode/client";

import {
  SHELL_MARKER,
  SHELL_TRIGGER,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from "./fixtures/fake-openai-server";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SWARMX_ENTRY = join(PACKAGE_ROOT, "dist", "index.js");
const PROBE_PLUGIN = join(PACKAGE_ROOT, "tests", "fixtures", "host-probe-plugin.ts");
const FAKE_CLI = join(PACKAGE_ROOT, "tests", "fixtures", "fake-swarm-cli.ts");

const OPENCODE_BIN =
  process.env.SWARMX_OPENCODE_BIN ??
  [join(process.env.HOME ?? "", ".opencode", "bin", "opencode")].find((path) => existsSync(path)) ??
  Bun.which("opencode") ??
  undefined;
const HOST_AVAILABLE = OPENCODE_BIN !== undefined && existsSync(OPENCODE_BIN);
if (!HOST_AVAILABLE) {
  console.warn("[real-host] SKIP: OpenCode V2 binary not found (set SWARMX_OPENCODE_BIN)");
}

const TEST_TIMEOUT_MS = 180_000;
const SERVER_READY_MS = 60_000;
const RUN_TIMEOUT_MS = 60_000;

type ProbeRecord = { kind: string; at: number; data: any };

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function readJsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drain(stream: ReadableStream<Uint8Array> | null, sink: string[]): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const part of stream) sink.push(decoder.decode(part, { stream: true }));
}

async function waitForServer(baseUrl: string, proc: { exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + SERVER_READY_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode serve exited early (${proc.exitCode})`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`opencode serve did not respond on ${baseUrl} within ${SERVER_READY_MS}ms`);
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("real OpenCode V2 host", () => {
  test.skipIf(!HOST_AVAILABLE)(
    "realV2HostLoadsSwarmxAndRunsToolHooks",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "swarmx-real-host-"));
      const project = join(root, "project");
      const home = join(root, "home");
      const xdg = (name: string) => join(root, "xdg", name);
      for (const dir of [project, home, join(root, "swarm-db"), xdg("config"), xdg("data"), xdg("cache"), xdg("state")]) {
        mkdirSync(dir, { recursive: true });
      }
      const probeLog = join(root, "probe.jsonl");
      const cliLog = join(root, "fake-cli.jsonl");
      const swarmDbPath = join(root, "swarm-db", `swarm-${crypto.randomUUID()}.db`);

      const serverLogs: string[] = [];
      let fakeModel: FakeOpenAIServer | undefined;
      let proc: ReturnType<typeof Bun.spawn> | undefined;
      const subscription = new AbortController();
      let failed = true;
      const diagnostics: string[] = [];

      try {
        expect(existsSync(SWARMX_ENTRY)).toBe(true); // run `bun run build` first

        // Executable launcher for the fake backend fixture (no reliance on file modes).
        const fakeCliBin = join(root, "fake-swarm");
        writeFileSync(
          fakeCliBin,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLI)} "$@"\n`,
          { mode: 0o755 },
        );

        const git = Bun.spawnSync(["git", "init", "-q", project]);
        expect(git.exitCode).toBe(0);
        writeFileSync(join(project, "README.md"), "# real-host smoke\n");

        fakeModel = startFakeOpenAIServer();
        const config = {
          $schema: "https://opencode.ai/config.json",
          model: "local/smoke",
          update: "disable",
          share: "disabled",
          snapshots: false,
          // Configured local plugin paths must be directories: the package root
          // resolves `exports["."]` to the built `dist/index.js`.
          plugins: [PACKAGE_ROOT],
          providers: {
            local: {
              name: "Local smoke",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: fakeModel.url, apiKey: "smoke-key" },
              models: {
                smoke: {
                  name: "Smoke",
                  capabilities: { tools: true },
                  limit: { context: 100_000, output: 4_096 },
                },
              },
            },
          },
          // Free/hosted models off: only the local provider may serve requests.
          policies: [
            { action: "provider.use", resource: "*", effect: "deny" },
            { action: "provider.use", resource: "local", effect: "allow" },
          ],
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "*", effect: "allow" },
            { action: "hive_ready", resource: "*", effect: "allow" },
          ],
        };
        // Single-file plugins are discovered from `.opencode/plugins/`; this shim
        // re-exports the probe so its imports resolve from the repository.
        mkdirSync(join(project, ".opencode", "plugins"), { recursive: true });
        writeFileSync(
          join(project, ".opencode", "plugins", "host-probe.ts"),
          `export { default } from ${JSON.stringify(PROBE_PLUGIN)};\n`,
        );
        writeFileSync(join(project, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);

        const versionRun = Bun.spawnSync([OPENCODE_BIN!, "--version"], {
          env: { ...process.env, HOME: home },
        });
        const hostVersion = versionRun.stdout.toString().trim();
        expect(hostVersion).toMatch(/\bv?2\.\d+\.\d+/);

        const password = crypto.randomUUID();
        const port = await freePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        proc = Bun.spawn([OPENCODE_BIN!, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
          cwd: project,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            XDG_CONFIG_HOME: xdg("config"),
            XDG_DATA_HOME: xdg("data"),
            XDG_CACHE_HOME: xdg("cache"),
            XDG_STATE_HOME: xdg("state"),
            OPENCODE_DB: ":memory:",
            OPENCODE_SERVER_PASSWORD: password,
            SWARM_DB_PATH: swarmDbPath,
            SWARMX_SWARM_BIN: fakeCliBin,
            SWARMX_FAKE_CLI_LOG: cliLog,
            SWARMX_PROBE_LOG: probeLog,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const pumps = [drain(proc.stdout as ReadableStream<Uint8Array>, serverLogs), drain(proc.stderr as ReadableStream<Uint8Array>, serverLogs)];
        cleanups.push(async () => {
          await Promise.allSettled(pumps);
        });
        await waitForServer(baseUrl, proc);

        const client = OpenCode.make({
          baseUrl,
          headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
        });
        const connectedEvents = client.event.subscribe({
          signal: subscription.signal,
        });
        const connectedIterator = connectedEvents[Symbol.asyncIterator]();
        const serverConnected = withTimeout(
          (async () => {
            while (true) {
              const step = await connectedIterator.next();
              if (step.done) throw new Error("server.connected event stream closed");
              if (step.value.type === "server.connected") return;
            }
          })(),
          RUN_TIMEOUT_MS,
          "server.connected",
        );
        const info = await withTimeout(client.server.info(), RUN_TIMEOUT_MS, "server.info");
        console.log(`[real-host] server.info=${JSON.stringify(info)}`);
        const session = await withTimeout(
          client.session.create({ location: { directory: project } } as never),
          RUN_TIMEOUT_MS,
          "session.create",
        );
        const sessionID = (session as { id: string }).id;
        expect(typeof sessionID).toBe("string");

        const settled: Array<{ type: string; raw: string }> = [];
        const events = client.event.subscribe({
          types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
          signal: subscription.signal,
        });
        const iterator = events[Symbol.asyncIterator]();
        const nextSettled = async (label: string): Promise<{ type: string; raw: string }> =>
          await withTimeout(
            (async () => {
              while (true) {
                const step = await iterator.next();
                if (step.done) throw new Error("event stream closed");
                const raw = JSON.stringify(step.value);
                if (step.value.type === "server.connected" || !raw.includes(sessionID)) continue;
                const item = { type: step.value.type, raw };
                settled.push(item);
                return item;
              }
            })(),
            RUN_TIMEOUT_MS,
            label,
          );

        await serverConnected;

        // Run 1: model calls the swarmx `hive_ready` tool.
        const run1 = nextSettled("hive_ready run");
        await client.session.prompt({ sessionID, text: "Find the next ready cell." });
        expect((await run1).type).toBe("session.execution.succeeded");

        // Run 2: model calls the built-in `shell` tool.
        const run2 = nextSettled("shell run");
        await client.session.prompt({ sessionID, text: `${SHELL_TRIGGER}: print the marker.` });
        expect((await run2).type).toBe("session.execution.succeeded");

        diagnostics.push(`settled=${JSON.stringify(settled).slice(0, 4_000)}`);
        diagnostics.push(`host plugin.list=${JSON.stringify(((await client.plugin.list({} as never)) as { data: Array<{ source: { type: string } }> }).data.filter((p) => p.source.type !== "builtin"))}`);
        const probe = readJsonLines(probeLog) as ProbeRecord[];

        // Active plugins: `{location, data[]}` with swarmx present.
        const pluginList = probe.find((record) => record.kind === "plugin.list")?.data;
        expect(pluginList).toBeDefined();
        expect(pluginList).toHaveProperty("location");
        expect(Array.isArray(pluginList.data)).toBe(true);
        expect(JSON.stringify(pluginList.data)).toContain("swarmx");

        // Tool catalogue: flat array containing `hive_ready` and `shell`.
        const toolList = probe.find((record) => record.kind === "tool.list")?.data;
        expect(Array.isArray(toolList)).toBe(true);
        const toolIds = (toolList as Array<{ id: string }>).map((tool) => tool.id);
        expect(toolIds).toContain("hive_ready");
        expect(toolIds).toContain("shell");

        const befores = probe.filter((record) => record.kind === "execute.before").map((r) => r.data);
        const afters = probe.filter((record) => record.kind === "execute.after").map((r) => r.data);

        // hive_ready: one host-driven before/after cycle sharing the same call id.
        const hiveBefore = befores.filter((input) => input.tool === "hive_ready");
        expect(hiveBefore).toHaveLength(1);
        const hiveAfter = afters.find((input) => input.id === hiveBefore[0].id);
        expect(hiveAfter).toBeDefined();
        expect(hiveBefore[0].callID).toBeUndefined();
        for (const field of ["sessionID", "agent", "messageID", "id"] as const) {
          expect(typeof hiveBefore[0][field]).toBe("string");
          expect(hiveBefore[0][field].length).toBeGreaterThan(0);
          expect(hiveAfter[field]).toBe(hiveBefore[0][field]);
        }
        expect(hiveBefore[0].sessionID).toBe(sessionID);
        diagnostics.push(`hive_ready after=${JSON.stringify({ ...hiveAfter, info: undefined }).slice(0, 3_000)}`);
        expect(hiveAfter.tool).toBe("hive_ready");
        expect(hiveAfter.status).toBe("completed");
        expect(JSON.stringify(hiveAfter.result.output)).toContain("fake-swarm-cli-7f3a");

        // The fake backend really ran, with the isolated DB path.
        const cliCalls = readJsonLines(cliLog);
        const hiveCalls = cliCalls.filter((call) => call.args[0] === "tool" && call.args[1] === "hive_ready");
        expect(hiveCalls).toHaveLength(1);
        expect(hiveCalls[0].swarmDbPath).toBe(swarmDbPath);

        // shell: second hook cycle with matching id and real output.
        const shellBefore = befores.filter((input) => input.tool === "shell");
        expect(shellBefore).toHaveLength(1);
        const shellAfter = afters.find((input) => input.id === shellBefore[0].id);
        expect(shellAfter).toBeDefined();
        expect(shellAfter.tool).toBe("shell");
        expect(shellAfter.sessionID).toBe(sessionID);
        expect(shellAfter.messageID).not.toBe(hiveAfter.messageID);
        expect(shellAfter.status).toBe("completed");
        expect(JSON.stringify(shellAfter.result.output)).toContain(SHELL_MARKER);

        // The model saw both tool results and produced final text.
        expect(fakeModel.requests.length).toBeGreaterThanOrEqual(4);
        expect(JSON.stringify(fakeModel.requests)).toContain("fake-swarm-cli-7f3a");

        console.log(
          `[real-host] host=${hostVersion} plugin=swarmx tool=hive_ready callID=${hiveBefore[0].id} db=${swarmDbPath}`,
        );
        failed = false;
      } finally {
        subscription.abort();
        if (proc) {
          proc.kill("SIGTERM");
          const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
          if (!exited) {
            proc.kill("SIGKILL");
            await proc.exited;
          }
        }
        await fakeModel?.stop();
        if (failed) {
          console.error(`[real-host] diagnostics:\n${diagnostics.join("\n")}`);
          console.error(
            `[real-host] model requests=${fakeModel?.requests.length ?? 0} tools=${JSON.stringify(((fakeModel?.requests[0] as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? []).map((t) => t.function?.name))}`,
          );
          console.error(`[real-host] server logs:\n${serverLogs.join("").slice(-8_000)}`);
          console.error(`[real-host] probe log:\n${existsSync(probeLog) ? readFileSync(probeLog, "utf8").slice(-8_000) : "<none>"}`);
          console.error(`[real-host] cli log:\n${existsSync(cliLog) ? readFileSync(cliLog, "utf8") : "<none>"}`);
        }
        rmSync(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
        if (proc) expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
