import { describe, expect, it } from "bun:test";
import * as registry from "./index";

type ToolDefinition = {
  name: string;
  parameters: {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: string[];
  };
};

function findTool(name: string): ToolDefinition {
  const definitions = Object.values(registry).flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const definition = definitions.find(
    (value): value is ToolDefinition =>
      typeof value === "object" && value !== null && "name" in value && value.name === name,
  );
  if (!definition) throw new Error(`Missing tool definition: ${name}`);
  return definition;
}

describe("optional operationId schemas", () => {
  it("allows operation_id on hive_create without making it required", () => {
    const schema = findTool("hive_create").parameters;

    expect(schema.properties).toHaveProperty("operation_id");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).not.toContain("operation_id");
  });

  it("allows operation_id on swarm_complete without making it required", () => {
    const schema = findTool("swarm_complete").parameters;

    expect(schema.properties).toHaveProperty("operation_id");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).not.toContain("operation_id");
  });

  it("allows operation_id on swarm_review_feedback without making it required", () => {
    const schema = findTool("swarm_review_feedback").parameters;

    expect(schema.properties).toHaveProperty("operation_id");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).not.toContain("operation_id");
  });
});
