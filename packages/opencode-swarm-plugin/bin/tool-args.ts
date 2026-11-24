/**
 * Parse `swarm tool <name> --json <args>` input. The parsed object is forwarded
 * to the tool unchanged (optional operation_id included; absence preserved).
 */
export function parseToolArgsJson(argsJson?: string): Record<string, unknown> {
  if (!argsJson) return {};
  return JSON.parse(argsJson) as Record<string, unknown>;
}
