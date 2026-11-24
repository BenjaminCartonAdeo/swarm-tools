/**
 * Builds the argv used by the MCP server to invoke `swarm tool <name> --json <args>`.
 * Arguments (including optional operation_id) are serialized unchanged; absent keys stay absent.
 */
export function buildToolCliArgs(name: string, args: Record<string, unknown>): string[] {
  return ["tool", name, "--json", JSON.stringify(args)];
}
