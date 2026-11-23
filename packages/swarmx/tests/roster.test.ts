/**
 * Deterministic roster resolution (Task 5).
 *
 * Pins the dispatchability filter, whole-word/diacritic folding, technology
 * hints, tie handling and the absolute rule that `swarm-worker` is never a
 * silent default.
 */
import { describe, expect, test } from "bun:test";

import { listRoster, resolveAgent, type RosterAgent } from "../src/roster";

function agent(overrides: Partial<RosterAgent> & Pick<RosterAgent, "id">): RosterAgent {
  return {
    name: overrides.id,
    description: undefined,
    mode: "subagent",
    hidden: false,
    ...overrides,
  } as RosterAgent;
}

const ROSTER: readonly RosterAgent[] = [
  agent({ id: "swarm-worker", description: "Dispatched subtask worker" }),
  agent({
    id: "typescript-pro",
    description: "TypeScript backend services with strict typing",
  }),
  agent({ id: "vue", description: "Vue single file components" }),
  agent({ id: "python-pro", description: "Python data pipelines" }),
  agent({ id: "prompt-engineer", description: "Prompt wording and documentation" }),
  agent({ id: "documentation-expert", description: "Reference documentation" }),
  agent({ id: "postgresql-pglite-pro", description: "SQL schemas and migrations" }),
  agent({ id: "test-automator", description: "Automated tests and coverage" }),
  agent({ id: "build", mode: "primary", description: "TypeScript feature implementation" }),
  agent({ id: "hidden-helper", hidden: true, description: "TypeScript feature implementation" }),
];

describe("listRoster", () => {
  test("keeps only visible non-primary agents and sorts by id", () => {
    const listed = listRoster([
      agent({ id: "zeta" }),
      agent({ id: "build", mode: "primary" }),
      agent({ id: "alpha" }),
      agent({ id: "secret", hidden: true }),
    ]);

    expect(listed.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
  });

  test("does not mutate the input roster", () => {
    const input = [agent({ id: "zeta" }), agent({ id: "alpha" })];
    const listed = listRoster(input);
    expect(input.map((entry) => entry.id)).toEqual(["zeta", "alpha"]);
    expect(listed.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("resolveAgent", () => {
  test("is deterministic across identical calls", () => {
    const cell = { title: "TypeScript strict typing refactor", files: ["src/api.ts"] };
    const first = resolveAgent(cell, ROSTER);
    const second = resolveAgent(cell, ROSTER);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("folds accents and case on whole words", () => {
    const roster = [
      agent({ id: "data", description: "Traitement des données et migration" }),
      agent({ id: "vue", description: "Vue single file components" }),
    ];

    const accented = resolveAgent({ title: "MIGRATION DES DONNEES", files: [] }, roster);
    expect(accented.agent).toBe("data");
    expect(accented.needs_arbitration).toBe(false);
  });

  test("whole-word matching: 'vue' never matches 'revue'", () => {
    const roster = [agent({ id: "vue", description: "Vue single file components" })];
    const result = resolveAgent({ title: "Revue des fichiers", files: [] }, roster);
    expect(result.agent).toBeNull();
    expect(result.needs_arbitration).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  test("a tie returns needs_arbitration with sorted candidates", () => {
    const roster = [
      agent({ id: "zeta", description: "shared domain wording" }),
      agent({ id: "alpha", description: "shared domain wording" }),
    ];
    const result = resolveAgent({ title: "shared domain wording", files: [] }, roster);
    expect(result.agent).toBeNull();
    expect(result.needs_arbitration).toBe(true);
    expect(result.candidates).toEqual(["alpha", "zeta"]);
    expect(result.rationale).toContain("ambiguous");
  });

  test("a zero score returns needs_arbitration without candidates", () => {
    const result = resolveAgent({ title: "Zzz qqq", files: [] }, ROSTER);
    expect(result.agent).toBeNull();
    expect(result.needs_arbitration).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.rationale).toContain("no roster agent matched");
  });

  test("an empty roster never produces a winner", () => {
    const result = resolveAgent({ title: "anything", files: ["a.ts"] }, []);
    expect(result.agent).toBeNull();
    expect(result.needs_arbitration).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  test("never defaults to swarm-worker when no signal matches", () => {
    const result = resolveAgent({ title: "Fix login bug", files: [] }, ROSTER);
    expect(result.agent).toBeNull();
    expect(result.agent).not.toBe("swarm-worker");
    expect(result.needs_arbitration).toBe(true);
  });

  test("swarm-worker can only win through a mechanical keyword", () => {
    const rename = resolveAgent({ title: "Rename the helper", files: [] }, ROSTER);
    expect(rename.agent).toBe("swarm-worker");
    expect(rename.needs_arbitration).toBe(false);

    const boilerplate = resolveAgent({ title: "Mécanique boilerplate", files: [] }, ROSTER);
    expect(boilerplate.agent).toBe("swarm-worker");
  });

  test("hidden and primary agents are never resolved", () => {
    const roster = [
      agent({ id: "build", mode: "primary", description: "TypeScript feature implementation" }),
      agent({ id: "hidden-types", hidden: true, description: "TypeScript feature implementation" }),
      agent({ id: "vue", description: "Vue single file components" }),
    ];
    const result = resolveAgent(
      { title: "TypeScript feature implementation", files: ["src/feature.ts"] },
      roster,
    );
    expect(result.agent).toBeNull();
    expect(result.needs_arbitration).toBe(true);
  });

  test("technology hints map real extensions to their agents", () => {
    expect(resolveAgent({ title: "Implement feature", files: ["src/a.ts"] }, ROSTER).agent).toBe(
      "typescript-pro",
    );
    expect(resolveAgent({ title: "Implement feature", files: ["src/a.tsx"] }, ROSTER).agent).toBe(
      "typescript-pro",
    );
    expect(resolveAgent({ title: "Implement feature", files: ["src/App.vue"] }, ROSTER).agent).toBe(
      "vue",
    );
    expect(resolveAgent({ title: "Implement feature", files: ["jobs/a.py"] }, ROSTER).agent).toBe(
      "python-pro",
    );
    expect(resolveAgent({ title: "Implement feature", files: ["db/a.sql"] }, ROSTER).agent).toBe(
      "postgresql-pglite-pro",
    );
    expect(resolveAgent({ title: "Implement feature", files: ["tests/a.ts"] }, ROSTER).agent).toBe(
      "test-automator",
    );
  });

  test("a .md file under docs/ resolves to documentation-expert", () => {
    const result = resolveAgent({ title: "Implement feature", files: ["docs/a.md"] }, ROSTER);
    expect(result.agent).toBe("documentation-expert");
    expect(result.needs_arbitration).toBe(false);
  });
});
