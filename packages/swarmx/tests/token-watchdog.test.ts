/**
 * Coordinator token watchdog (P1.9).
 *
 * Two layers are covered:
 *   - the pure classifier (`token-watchdog.ts`) driven by plain mocked counts;
 *   - the plugin wiring, driving the registered `context` hook with a fake
 *     session whose token counters are mocked. The hook must append advisory
 *     text, skip workers, and never throw.
 */
import { describe, expect, test } from "bun:test";

import { Plugin } from "@opencode/plugin";

import { createSwarmxPlugin } from "../src/index";
import {
  TOKEN_NOTICE_THRESHOLD,
  TOKEN_PRESSURE_HOOK_NAME,
  TOKEN_WARN_THRESHOLD,
  createTokenWatchdog,
} from "../src/token-watchdog";
import { createFakeContext, type FakeSessionInfo } from "./helpers";

function sessionInfo(overrides: Partial<FakeSessionInfo> = {}): FakeSessionInfo {
  return {
    id: "ses_root",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

describe("token watchdog classification", () => {
  test("thresholds are the documented 300k / 500k", () => {
    expect(TOKEN_WARN_THRESHOLD).toBe(300_000);
    expect(TOKEN_NOTICE_THRESHOLD).toBe(500_000);
  });

  test("below the warning threshold emits nothing", () => {
    const watchdog = createTokenWatchdog();
    expect(watchdog.evaluate("ses", 0)).toBeUndefined();
    expect(watchdog.evaluate("ses", TOKEN_WARN_THRESHOLD - 1)).toBeUndefined();
  });

  test("300k emits a warning", () => {
    const notice = createTokenWatchdog().evaluate("ses", TOKEN_WARN_THRESHOLD);
    expect(notice?.level).toBe("warning");
    expect(notice?.threshold).toBe(TOKEN_WARN_THRESHOLD);
    expect(notice?.text).toContain("<swarmx_token_pressure");
    expect(notice?.text).toContain("/compact");
    expect(notice?.text).toContain("/checkpoint");
  });

  test("500k emits the notice instead of another warning", () => {
    const notice = createTokenWatchdog().evaluate("ses", TOKEN_NOTICE_THRESHOLD);
    expect(notice?.level).toBe("notice");
    expect(notice?.threshold).toBe(TOKEN_NOTICE_THRESHOLD);
    expect(notice?.text).toContain("/compact or /checkpoint");
  });

  test("499,999 tokens still only warns", () => {
    const notice = createTokenWatchdog().evaluate("ses", TOKEN_NOTICE_THRESHOLD - 1);
    expect(notice?.level).toBe("warning");
  });

  test("each threshold is emitted once per crossing", () => {
    const watchdog = createTokenWatchdog();
    expect(watchdog.evaluate("ses", 310_000)?.level).toBe("warning");
    expect(watchdog.evaluate("ses", 320_000)).toBeUndefined();
    expect(watchdog.evaluate("ses", 510_000)?.level).toBe("notice");
    expect(watchdog.evaluate("ses", 900_000)).toBeUndefined();
  });

  test("sessions are tracked independently", () => {
    const watchdog = createTokenWatchdog();
    expect(watchdog.evaluate("ses-a", 310_000)?.level).toBe("warning");
    expect(watchdog.evaluate("ses-b", 310_000)?.level).toBe("warning");
  });

  test("dropping below the warning threshold re-arms the watchdog", () => {
    const watchdog = createTokenWatchdog();
    expect(watchdog.evaluate("ses", 310_000)?.level).toBe("warning");
    expect(watchdog.evaluate("ses", 100_000)).toBeUndefined();
    expect(watchdog.evaluate("ses", 310_000)?.level).toBe("warning");
  });

  test("reset(sessionID) forgets one session; reset() forgets all", () => {
    const watchdog = createTokenWatchdog();
    expect(watchdog.evaluate("ses-a", 310_000)?.level).toBe("warning");
    expect(watchdog.evaluate("ses-b", 310_000)?.level).toBe("warning");
    watchdog.reset("ses-a");
    expect(watchdog.evaluate("ses-a", 310_000)?.level).toBe("warning");
    expect(watchdog.evaluate("ses-b", 310_000)).toBeUndefined();
    watchdog.reset();
    expect(watchdog.evaluate("ses-b", 310_000)?.level).toBe("warning");
  });

  test("non-finite and negative counts are ignored", () => {
    const watchdog = createTokenWatchdog();
    expect(watchdog.evaluate("ses", Number.NaN)).toBeUndefined();
    expect(watchdog.evaluate("ses", Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(watchdog.evaluate("ses", -1)).toBeUndefined();
    // Ignored observations do not consume the warning.
    expect(watchdog.evaluate("ses", 310_000)?.level).toBe("warning");
  });

  test("invalid custom thresholds are rejected", () => {
    expect(() => createTokenWatchdog({ warnAt: 0 })).toThrow(RangeError);
    expect(() => createTokenWatchdog({ warnAt: 500, noticeAt: 300 })).toThrow(RangeError);
  });
});

describe("token watchdog plugin wiring", () => {
  async function rig(sessionInfoFor: (sessionID: string) => FakeSessionInfo | undefined) {
    const ctx = createFakeContext({ sessionInfo: sessionInfoFor });
    await createSwarmxPlugin().setup(ctx as unknown as Plugin.Context);
    const [hook] = ctx.captures.sessionHooks.get(TOKEN_PRESSURE_HOOK_NAME) ?? [];
    expect(hook).toBeDefined();
    return { ctx, hook: hook! };
  }

  test("appends a warning system part at 300k", async () => {
    const { ctx, hook } = await rig(() =>
      sessionInfo({ tokens: { input: 310_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    );
    const event = ctx.createContextEvent({ sessionID: "ses_root" });
    const before = event.system.length;
    await hook(event);
    expect(event.system).toHaveLength(before + 1);
    expect(event.system.at(-1)?.text).toContain('level="warning"');
  });

  test("appends the compact notice at 500k and only once", async () => {
    const { ctx, hook } = await rig(() => sessionInfo({ tokens: { input: 510_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
    const first = ctx.createContextEvent({ sessionID: "ses_root" });
    await hook(first);
    expect(first.system.at(-1)?.text).toContain('level="notice"');

    const second = ctx.createContextEvent({ sessionID: "ses_root" });
    const before = second.system.length;
    await hook(second);
    expect(second.system).toHaveLength(before);
  });

  test("stays silent below 300k", async () => {
    const { ctx, hook } = await rig(() => sessionInfo({ tokens: { input: 299_999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
    const event = ctx.createContextEvent({ sessionID: "ses_root" });
    const before = event.system.length;
    await hook(event);
    expect(event.system).toHaveLength(before);
  });

  test("ignores worker (child) sessions, including a null parent root", async () => {
    const { ctx, hook } = await rig((sessionID) =>
      sessionID === "ses_worker"
        ? sessionInfo({ id: "ses_worker", parentID: "ses_root", tokens: { input: 900_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
        : sessionInfo({ id: sessionID, parentID: null, tokens: { input: 900_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    );

    const worker = ctx.createContextEvent({ sessionID: "ses_worker" });
    const workerBefore = worker.system.length;
    await hook(worker);
    expect(worker.system).toHaveLength(workerBefore);

    const root = ctx.createContextEvent({ sessionID: "ses_root" });
    await hook(root);
    expect(root.system.at(-1)?.text).toContain('level="notice"');
  });

  test("a failing session lookup never throws and appends nothing", async () => {
    const { ctx, hook } = await rig(() => {
      throw new Error("session API offline");
    });
    const event = ctx.createContextEvent({ sessionID: "ses_root" });
    const before = event.system.length;
    await expect(hook(event)).resolves.toBeUndefined();
    expect(event.system).toHaveLength(before);
  });
});
