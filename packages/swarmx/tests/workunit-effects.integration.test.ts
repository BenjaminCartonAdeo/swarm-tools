import { afterEach, describe, expect, test } from "bun:test";
import { createLibSQLAdapter, type DatabaseAdapter } from "swarm-mail";
import { ensureWorkUnitSchema } from "../src/workunit/schema.js";
import {
  claimEffect,
  EffectClaimConflictError,
  EffectNotFoundError,
  recoverStaleEffects,
  recordEffectResult,
} from "../src/workunit/effects.js";

const databases: DatabaseAdapter[] = [];

async function seedEffect({
  effectId = "effect-1",
  unitId = "unit-1",
  unitState = "PUBLISHING",
  unitFence = 7,
  effectFence = unitFence,
  effectState = "pending",
}: {
  effectId?: string;
  unitId?: string;
  unitState?: "PUBLISHING" | "RETURNING";
  unitFence?: number;
  effectFence?: number;
  effectState?: "pending" | "unknown" | "in_flight";
} = {}): Promise<DatabaseAdapter> {
  const db = await createLibSQLAdapter({ url: ":memory:" });
  databases.push(db);
  await ensureWorkUnitSchema(db);
  await db.query(
    "INSERT INTO swarmx_missions (id, project, session_id, mission_id, state, fence, created_at, updated_at) VALUES ('mission-1', 'project', 'session', 'mission', 'OPEN', 1, 0, 0)",
  );
  await db.query(
    "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES (?, 'project', 'mission-1', ?, ?, 1, ?, ?, 0, 0)",
    [unitId, `call-${unitId}`, `idem-${unitId}`, unitState, unitFence],
  );
  await db.query(
    "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES (?, ?, 'backend_complete', 1, ?, ?, 0, 0)",
    [effectId, unitId, effectFence, effectState],
  );
  return db;
}

async function readEffect(db: DatabaseAdapter, effectId = "effect-1"): Promise<Record<string, unknown>> {
  const result = await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effectId]);
  return result.rows[0] as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close?.()));
});

describe("work unit effect journal claims", () => {
  test("effectClaimIsExclusive and persists the complete fenced claim", async () => {
    const db = await seedEffect();
    const input = {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING" as const,
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    };

    const [first, second] = await Promise.all([claimEffect(db, input), claimEffect(db, input)]);

    expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);
    const winner = first ?? second;
    expect(winner).not.toBeNull();
    const persisted = await readEffect(db);
    expect(persisted).toMatchObject({
      unit_fence: 7,
      state: "in_flight",
      claim_token: winner?.claimToken,
      host_instance_id: "host-1",
      claimed_hostname: "worker-a",
      claimed_by_pid: 321,
    });
    expect(typeof persisted.claim_token).toBe("string");
    expect(typeof persisted.claimed_at).toBe("number");
  });

  test("resultRequiresClaimToken", async () => {
    const db = await seedEffect();
    const claim = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });

    expect(claim).not.toBeNull();
    await expect(recordEffectResult(db, {
      effectId: "effect-1",
      claimToken: "not-the-current-token",
      state: "succeeded",
      result: { published: true },
    })).rejects.toBeInstanceOf(EffectClaimConflictError);
    await expect(recordEffectResult(db, {
      effectId: "missing-effect",
      claimToken: "any-token",
      state: "succeeded",
    })).rejects.toBeInstanceOf(EffectNotFoundError);

    const result = await recordEffectResult(db, {
      effectId: "effect-1",
      claimToken: claim!.claimToken,
      state: "succeeded",
      result: { published: true },
    });
    expect(result).toMatchObject({ state: "succeeded", result_json: '{"published":true}' });
    expect(result.claim_token).toBeNull();
    expect(result.host_instance_id).toBeNull();
  });

  test("deadSameHostPidBecomesUnknown", async () => {
    const db = await seedEffect();
    const claim = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });
    expect(claim).not.toBeNull();

    const recovered = await recoverStaleEffects(db, {
      hostInstanceId: "host-1",
      hostname: "worker-a",
      isProcessAlive: (pid) => pid !== 321,
    });

    expect(recovered).toEqual({ recovered: 1, foreignHostCandidates: [] });
    expect(await readEffect(db)).toMatchObject({
      state: "unknown",
      claim_token: null,
      host_instance_id: null,
      claimed_hostname: null,
      claimed_by_pid: null,
      claimed_at: null,
    });
  });

  test("liveForeignHostClaimIsNotRecovered", async () => {
    const db = await seedEffect();
    await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-foreign",
      hostname: "other-machine",
      pid: 654,
    });
    await db.query(
      "INSERT INTO swarmx_work_units (id, project, mission_pk, call_id, idem_key, attempt_no, state, fence, created_at, updated_at) VALUES ('unit-live', 'project', 'mission-1', 'call-live', 'idem-live', 1, 'RETURNING', 3, 0, 0)",
    );
    await db.query(
      "INSERT INTO swarmx_effects (effect_id, unit_id, kind, mandatory, unit_fence, state, attempt, updated_at) VALUES ('effect-live', 'unit-live', 'backend_complete', 1, 3, 'pending', 0, 0)",
    );
    await claimEffect(db, {
      effectId: "effect-live",
      unitId: "unit-live",
      expectedUnitState: "RETURNING",
      unitFence: 3,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });

    const recovered = await recoverStaleEffects(db, {
      hostInstanceId: "host-1",
      hostname: "worker-a",
      isProcessAlive: (pid) => pid === 321,
    });

    expect(recovered).toEqual({ recovered: 0, foreignHostCandidates: ["effect-1"] });
    expect(await readEffect(db)).toMatchObject({ state: "in_flight", host_instance_id: "host-foreign" });
    expect(await readEffect(db, "effect-live")).toMatchObject({ state: "in_flight", host_instance_id: "host-1" });
  });

  test("runnerRejectsStaleUnitFence", async () => {
    const db = await seedEffect({ unitFence: 8, effectFence: 7 });

    const claim = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });

    expect(claim).toBeNull();
    expect(await readEffect(db)).toMatchObject({ state: "pending", claim_token: null });
  });

  test("lateResolveFromStaleTokenIsRejectedAfterRecoveryAndReclaim", async () => {
    const db = await seedEffect();
    const original = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-1",
      hostname: "worker-a",
      pid: 321,
    });
    expect(original).not.toBeNull();

    await recoverStaleEffects(db, {
      hostInstanceId: "host-1",
      hostname: "worker-a",
      isProcessAlive: () => false,
    });
    const replacement = await claimEffect(db, {
      effectId: "effect-1",
      unitId: "unit-1",
      expectedUnitState: "PUBLISHING",
      unitFence: 7,
      hostInstanceId: "host-2",
      hostname: "worker-b",
      pid: 987,
    });

    expect(replacement).not.toBeNull();
    expect(replacement?.claimToken).not.toBe(original?.claimToken);
    await expect(recordEffectResult(db, {
      effectId: "effect-1",
      claimToken: original!.claimToken,
      state: "succeeded",
      result: { stale: true },
    })).rejects.toBeInstanceOf(EffectClaimConflictError);
    expect((await readEffect(db)).state).toBe("in_flight");
  });
});
