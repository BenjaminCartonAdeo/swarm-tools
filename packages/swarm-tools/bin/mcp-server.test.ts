import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SWARM_TOOLS } from "../index.js";
import { buildToolCliArgs } from "./tool-cli-args.js";

describe("MCP tool forwarding operation_id (operationId)", () => {
  for (const name of ["hive_create", "swarm_review_feedback"]) {
    test(`${name} forwards supplied operation_id unchanged`, () => {
      const args = { title: "t", operation_id: "op-ÉX 42/α" };
      const argv = buildToolCliArgs(name, args);
      expect(argv.slice(0, 3)).toEqual(["tool", name, "--json"]);
      expect(JSON.parse(argv[3])).toEqual(args);
    });

    test(`${name} keeps operation_id absent when omitted`, () => {
      const parsed = JSON.parse(buildToolCliArgs(name, { title: "t" })[3]);
      expect("operation_id" in parsed).toBe(false);
    });
  }

  test("canonical schemas accept optional operation_id", () => {
    for (const name of ["hive_create", "swarm_review_feedback"]) {
      const tool = SWARM_TOOLS.find((t) => t.name === name)!;
      const params = tool.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
      expect(params.properties.operation_id).toEqual(expect.objectContaining({ type: "string" }));
      expect(params.required).not.toContain("operation_id");
    }
  });

  test("built MCP bundle serializes the complete tool arguments to the CLI", () => {
    const bundle = readFileSync(new URL("./mcp-server.js", import.meta.url), "utf8");

    expect(bundle).toMatch(/return\["tool",\$,"--json",JSON\.stringify\(v\)\]/);
  });
});
