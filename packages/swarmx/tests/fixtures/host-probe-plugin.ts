/**
 * Probe plugin loaded by the real OpenCode V2 host (Task 19).
 *
 * Records the host-reported plugin list, tool catalogue and every real
 * `execute.before` / `execute.after` payload as JSON lines in the file named by
 * `$SWARMX_PROBE_LOG`. Hook registrations are disposed on plugin cleanup.
 */
import { appendFileSync } from "node:fs";

import { Plugin } from "@opencode/plugin";

function record(kind: string, data: unknown): void {
  const file = process.env.SWARMX_PROBE_LOG;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ kind, at: Date.now(), data })}\n`);
}

function safe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

export default Plugin.define({
  id: "swarmx-host-probe",
  setup: async (ctx) => {
    // Catalogue snapshots are taken at hook time: other plugins may still be
    // loading while this setup runs.
    const snapshot = async (): Promise<void> => {
      try {
        record("plugin.list", safe(await ctx.plugin.list()));
      } catch (error) {
        record("plugin.list.error", String(error));
      }
      try {
        const tools = await ctx.tool.list();
        record("tool.list", safe(tools.map((tool) => ({ id: tool.id }))));
      } catch (error) {
        record("tool.list.error", String(error));
      }
    };

    const before = await ctx.tool.hook("execute.before", async (input) => {
      record("execute.before", safe(input));
      await snapshot();
    });
    const after = await ctx.tool.hook("execute.after", (input) => {
      record("execute.after", safe(input));
    });

    return async () => {
      await before.dispose();
      await after.dispose();
      record("disposed", null);
    };
  },
});
