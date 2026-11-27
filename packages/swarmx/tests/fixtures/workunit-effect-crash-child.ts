import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createLibSQLAdapter } from "swarm-mail";
import { claimEffect, recordEffectResult } from "../../src/workunit/effects.js";

/** Fixture-only crash boundaries; never read by production code. */
export type CrashBoundary = "before_claim" | "after_claim" | "after_side_effect" | "before_result_write" | "after_result_write";

export const CRASH_EXIT_CODE = 86;

export interface LedgerEntry {
  operation_id: string;
  tool: string;
  applied: boolean;
  pid: number;
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
}

/** Append-only fake external backend that deduplicates by operation_id. */
export function applyExternal(path: string, tool: string, args: Record<string, unknown>): { operation_id: string; applied: boolean } {
  const operationId = args.operation_id;
  if (typeof operationId !== "string") throw new Error("operation_id required");
  const applied = !readLedger(path).some((entry) => entry.operation_id === operationId && entry.applied);
  appendFileSync(path, `${JSON.stringify({ operation_id: operationId, tool, applied, pid: process.pid })}\n`);
  return { operation_id: operationId, applied };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function crash(): never {
  process.exit(CRASH_EXIT_CODE);
}

async function main(): Promise<void> {
  const dbPath = requiredEnv("SWARM_DB_PATH");
  const at = requiredEnv("SWARMX_CRASH_AT") as CrashBoundary;
  const effectId = requiredEnv("SWARMX_EFFECT_ID");
  const ledgerPath = requiredEnv("SWARMX_LEDGER_PATH");
  const tokenPath = requiredEnv("SWARMX_TOKEN_PATH");
  const db = await createLibSQLAdapter({ url: `file:${dbPath}` });

  const row = (await db.query("SELECT * FROM swarmx_effects WHERE effect_id = ?", [effectId])).rows[0] as
    | { unit_id: string; kind: string; unit_fence: number; operation_id: string; request_json: string }
    | undefined;
  if (row === undefined) throw new Error(`effect ${effectId} not seeded`);
  if (at === "before_claim") crash();

  const expectedUnitState = row.kind === "backend_feedback" ? "RETURNING" : "PUBLISHING";
  const claim = await claimEffect(db, {
    effectId,
    unitId: row.unit_id,
    expectedUnitState,
    unitFence: row.unit_fence,
    hostInstanceId: requiredEnv("SWARMX_HOST_INSTANCE_ID"),
    hostname: requiredEnv("SWARMX_HOSTNAME"),
    pid: process.pid,
  });
  if (claim === null) throw new Error("claim failed");
  writeFileSync(tokenPath, claim.claimToken);
  if (at === "after_claim") crash();

  const tool = row.kind === "backend_feedback" ? "swarm_review_feedback" : "swarm_complete";
  const args = { ...(JSON.parse(row.request_json) as Record<string, unknown>), operation_id: row.operation_id };
  const port = (name: string, input: Record<string, unknown>) => {
    const result = applyExternal(ledgerPath, name, input);
    if (at === "after_side_effect") crash();
    return result;
  };
  const result = port(tool, args);
  if (at === "before_result_write") crash();

  await recordEffectResult(db, { effectId, claimToken: claim.claimToken, state: "succeeded", result });
  crash(); // after_result_write: result is durably committed before exit
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ fixtureError: String(error) })}\n`);
    process.exit(1);
  });
}
