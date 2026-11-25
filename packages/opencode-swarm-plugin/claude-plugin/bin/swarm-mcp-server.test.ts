import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("built Claude MCP server argument forwarding", () => {
  test("passes the complete MCP arguments object to the registered tool", () => {
    const bundle = readFileSync(
      new URL("./swarm-mcp-server.cjs", import.meta.url),
      "utf8",
    );

    expect(bundle).toContain(
      "toolDef.execute(args ?? {}, createToolContext())",
    );
  });
});
