/**
 * Fake OpenCode V2 plugin context for swarmx tests.
 *
 * Mirrors the *shape* of `@opencode/plugin`'s `Context` closely enough that the
 * plugin can be registered under Bun without a real host: `tool.transform`
 * (object editor), `tool.hook`, `session.hook`, `command.transform`,
 * `permission.hook`, `storage`, `agent.list()` and `location`.
 *
 * No network, no filesystem, no Effect runtime. Every registration is captured
 * so tests can replay it against controlled fixtures.
 *
 * The object is intentionally not assignable to `Plugin.Context` (the real type
 * is nominal via Effect schemas); callers bridge with a documented
 * `as unknown as Plugin.Context` cast.
 */

/** Tool/agent/session ids are plain strings in the fake host. */
export type FakeId = string;

export type FakeAgentMode = "subagent" | "primary" | "all";

export interface FakePermission {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface FakePermissionAssertion {
  readonly sessionID: string;
  readonly agent: string;
  readonly source: { readonly type: "tool"; readonly messageID: string; readonly id: string };
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
}

export interface FakePermissionEvaluation {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: string[];
  effect: "allow" | "deny" | "ask";
  message?: string;
}

/** Structurally aligned with `Agent.Info` fields used by swarmx. */
export interface FakeAgentInfo {
  readonly id: FakeId;
  readonly name: string;
  readonly description?: string;
  readonly mode: FakeAgentMode;
  readonly hidden: boolean;
  readonly permissions: readonly FakePermission[];
}

/** Skill record returned by the V2 skill catalog. */
export interface FakeSkillInfo {
  readonly id: FakeId;
  readonly name: string;
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content: string;
}

export interface FakeRegistration {
  dispose(): Promise<void>;
}

export type TransformCallback<Editor> = (editor: Editor) => void;
export type HookCallback<Payload> = (payload: Payload) => Promise<void> | void;

/**
 * Minimal tool definition accepted by the fake editor.
 *
 * Mirrors the real `Tool.Info`: `add()` takes `{ name, description, input,
 * execute }` and the editor derives the `id` itself. `id` is therefore optional
 * on input and always populated on values returned by `list()`/`get()`.
 */
export interface FakeToolInfo {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly output?: unknown;
  execute(input: unknown, context: unknown): Promise<{ output?: unknown; content?: unknown; metadata?: unknown }>;
}

/** Editable view passed to `update` (mirrors `Types.Mutable<Info>`). */
export type FakeToolInfoMutable = { -readonly [Key in keyof FakeToolInfo]: FakeToolInfo[Key] };

/** Object editor matching `ToolEditor` semantics (sync, replayable). */
export interface FakeToolEditor {
  list(): readonly FakeToolInfo[];
  get(id: string): FakeToolInfo | undefined;
  namespace(namespace: string): void;
  add(tool: FakeToolInfo): void;
  update(id: string, update: (tool: FakeToolInfoMutable) => void): void;
  remove(id: string): void;
}

/** Command editor matching `CommandEditor` semantics (add-only). */
export interface FakeCommandInvocation {
  readonly sessionID: FakeId;
  readonly prompt: string;
  readonly delivery: string;
}

export interface FakeCommandDefinition {
  readonly name: string;
  readonly description?: string;
  execute(input: FakeCommandInvocation): Promise<void>;
}

export interface FakeCommandEditor {
  add(definition: FakeCommandDefinition): void;
}

export interface FakeSystemPart {
  readonly type: "text";
  readonly text: string;
  readonly cache?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** Structurally aligned with `SessionCompaction` (V2 hook payload). */
export interface FakeCompactionEvent {
  readonly sessionID: FakeId;
  readonly model: string;
  readonly system: FakeSystemPart[];
  readonly messages: readonly unknown[];
  readonly options: Record<string, unknown>;
  readonly agent: string;
  readonly tools: Record<string, { readonly description: string; readonly input: unknown }>;
  result?: {
    readonly summary: string;
    readonly metadata?: Record<string, unknown>;
    readonly tokens?: unknown;
  };
}

/** Structurally aligned with `SessionContext` (V2 `context` hook payload). */
export interface FakeSessionContextEvent {
  readonly sessionID: FakeId;
  readonly model: string;
  system: FakeSystemPart[];
  readonly messages: readonly unknown[];
  readonly options: Record<string, unknown>;
  readonly agent: string;
  readonly tools: Record<string, { readonly description: string; readonly input: unknown }>;
}

/** Minimal `Session.Info` subset read by swarmx (parent link + token counters). */
export interface FakeSessionInfo {
  readonly id: FakeId;
  readonly parentID?: FakeId | null;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
}

/** Structurally aligned with `ToolHooks["execute.before"]`. */
export interface FakeToolBeforePayload {
  tool: string;
  readonly sessionID: FakeId;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  input: unknown;
}

/** Structurally aligned with `ToolHooks["execute.after"]` (never rejects). */
export type FakeToolAfterPayload = {
  readonly tool: string;
  readonly sessionID: FakeId;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
} & ({ readonly status: "completed"; result: unknown } | { readonly status: "error"; error: unknown });

/** Best-effort shape of `ctx.permission.hook("evaluate")` payload. */
export interface FakePermissionPayload {
  readonly permission: string;
  readonly pattern: string;
  effect: "allow" | "deny" | "ask";
  message?: string;
}

export interface FakeStorageEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface FakeStorageScanOptions {
  readonly prefix: string;
  readonly after?: string;
  readonly limit?: number;
}

export interface FakeStorageScanResult {
  readonly entries: readonly FakeStorageEntry[];
  readonly next?: string;
}

/** `ctx.storage` contract: get/set/remove/scan (no delete/list), async. */
export interface FakeStorage {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: FakeStorageScanOptions): Promise<FakeStorageScanResult>;
  /** Test-only escape hatch to inspect raw contents. */
  readonly map: Map<string, unknown>;
}

export interface FakeContextCaptures {
  readonly toolTransforms: TransformCallback<FakeToolEditor>[];
  readonly toolHooks: Map<string, HookCallback<unknown>[]>;
  readonly sessionHooks: Map<string, HookCallback<unknown>[]>;
  readonly commandTransforms: TransformCallback<FakeCommandEditor>[];
  readonly permissionHooks: Map<string, HookCallback<unknown>[]>;
  readonly permissionAssertions: FakePermissionAssertion[];
  readonly registrations: FakeRegistration[];
}

export interface FakeContextOptions {
  readonly agents?: readonly FakeAgentInfo[];
  readonly skills?: readonly FakeSkillInfo[];
  readonly permissionAssert?: (input: FakePermissionAssertion) => Promise<void>;
  readonly storage?: Iterable<readonly [string, unknown]>;
  readonly projectId?: string;
  readonly projectPath?: string;
  /** Session lookup used by `ctx.session.get` (token watchdog, parent reads). */
  readonly sessionInfo?: (
    sessionID: FakeId,
  ) => FakeSessionInfo | undefined | Promise<FakeSessionInfo | undefined>;
}

export interface FakeContext {
  readonly location: {
    readonly project: {
      readonly id: string;
      readonly directory: string;
      readonly canonical: string;
    };
    readonly directory: string;
  };
  readonly tool: {
    transform(callback: TransformCallback<FakeToolEditor>): Promise<FakeRegistration>;
    hook(name: string, callback: HookCallback<unknown>): Promise<FakeRegistration>;
  };
  readonly session: {
    hook(name: string, callback: HookCallback<unknown>): Promise<FakeRegistration>;
    get(input: { readonly sessionID: FakeId }): Promise<FakeSessionInfo>;
    context(input: { readonly sessionID: FakeId }): Promise<readonly unknown[]>;
  };
  readonly command: {
    transform(callback: TransformCallback<FakeCommandEditor>): Promise<FakeRegistration>;
  };
  readonly permission: {
    assert(input: FakePermissionAssertion): Promise<void>;
    hook(name: string, callback: HookCallback<unknown>): Promise<FakeRegistration>;
  };
  readonly storage: FakeStorage;
  readonly agent: { list(): Promise<readonly FakeAgentInfo[]> };
  readonly skill: {
    list(): Promise<{ readonly location: { readonly directory: string }; readonly data: readonly FakeSkillInfo[] }>;
  };
  readonly captures: FakeContextCaptures;
  /** Fresh empty editor for replaying a captured transform. */
  createEditor(): FakeToolEditor;
  /** Fresh compaction event with one baseline system part. */
  createCompactionEvent(overrides?: Partial<FakeCompactionEvent>): FakeCompactionEvent;
  /** Fresh `context` hook event with one baseline system part. */
  createContextEvent(overrides?: Partial<FakeSessionContextEvent>): FakeSessionContextEvent;
}

/** Three representative agents: primary, visible subagent, hidden subagent. */
export const DEFAULT_FAKE_AGENTS: readonly FakeAgentInfo[] = [
  {
    id: "build",
    name: "build",
    description: "Primary implementation agent",
    mode: "primary",
    hidden: false,
    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
  },
  {
    id: "swarm-worker",
    name: "swarm-worker",
    description: "Dispatched subtask worker",
    mode: "subagent",
    hidden: false,
    permissions: [{ action: "bash", resource: "*", effect: "ask" }],
  },
  {
    id: "internal-helper",
    name: "internal-helper",
    description: "Hidden internal subagent",
    mode: "subagent",
    hidden: true,
    permissions: [],
  },
];

function createFakeStorage(initial?: Iterable<readonly [string, unknown]>): FakeStorage {
  const map = new Map<string, unknown>(initial ?? []);
  return {
    map,
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async scan(options) {
      const keys = [...map.keys()].filter((key) => key.startsWith(options.prefix)).sort();
      const after = options.after;
      const start = after === undefined ? 0 : keys.findIndex((key) => key > after);
      const window = start === -1 ? [] : keys.slice(start);
      const limit = options.limit ?? window.length;
      const page = window.slice(0, limit);
      const hasMore = window.length > page.length;
      const last = page.at(-1);
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        ...(hasMore && last !== undefined ? { next: last } : {}),
      };
    },
  };
}

/**
 * Creates a fake V2 context.
 *
 * @param options - agent roster, initial storage entries and project id overrides.
 * @returns A context whose registrations are captured for assertions.
 */
export function createFakeContext(options: FakeContextOptions = {}): FakeContext {
  const agents = options.agents ?? DEFAULT_FAKE_AGENTS;
  const skills = options.skills ?? [];
  const storage = createFakeStorage(options.storage);
  const captures: FakeContextCaptures = {
    toolTransforms: [],
    toolHooks: new Map(),
    sessionHooks: new Map(),
    commandTransforms: [],
    permissionHooks: new Map(),
    permissionAssertions: [],
    registrations: [],
  };

  const register = async (): Promise<FakeRegistration> => {
    const registration: FakeRegistration = { dispose: async () => undefined };
    captures.registrations.push(registration);
    return registration;
  };

  const captureHook = (bucket: Map<string, HookCallback<unknown>[]>, name: string, callback: HookCallback<unknown>): void => {
    const callbacks = bucket.get(name);
    if (callbacks === undefined) {
      bucket.set(name, [callback]);
      return;
    }
    callbacks.push(callback);
  };

  const createEditor = (): FakeToolEditor => {
    const tools = new Map<string, FakeToolInfo>();
    let namespace: string | undefined;
    const effectiveId = (name: string): string =>
      namespace === undefined ? name : `${namespace}_${name}`;
    return {
      list: () => [...tools.values()],
      get: (id) => tools.get(id),
      namespace: (next) => {
        namespace = next;
      },
      add: (tool) => {
        // The real editor derives the id from the (namespaced) name; callers
        // never supply one. Keying by id would collapse every tool onto
        // `undefined`.
        const id = effectiveId(tool.name);
        tools.set(id, { ...tool, id });
      },
      update: (id, update) => {
        const existing = tools.get(id);
        if (existing === undefined) return;
        const draft: FakeToolInfoMutable = { ...existing };
        update(draft);
        tools.set(id, { ...draft, id });
      },
      remove: (id) => {
        tools.delete(id);
      },
    };
  };

  return {
    location: {
      project: {
        id: options.projectId ?? "adeo",
        directory: options.projectPath ?? "/fake/project",
        canonical: options.projectPath ?? "/fake/project",
      },
      directory: "/fake/project",
    },
    tool: {
      async transform(callback) {
        captures.toolTransforms.push(callback);
        return register();
      },
      async hook(name, callback) {
        captureHook(captures.toolHooks, name, callback);
        return register();
      },
    },
    session: {
      async hook(name, callback) {
        captureHook(captures.sessionHooks, name, callback);
        return register();
      },
      async get(input) {
        const info = await options.sessionInfo?.(input.sessionID);
        if (info === undefined) throw new Error(`fake session not found: ${input.sessionID}`);
        return info;
      },
      async context() {
        return [];
      },
    },
    command: {
      async transform(callback) {
        captures.commandTransforms.push(callback);
        return register();
      },
    },
    permission: {
      async assert(input) {
        captures.permissionAssertions.push(input);
        const agent = agents.find((candidate) => candidate.id === input.agent);
        const matches = (pattern: string, value: string): boolean =>
          pattern === "*" || pattern === value;
        const effect = (agent?.permissions ?? [])
          .filter(
            (rule) =>
              matches(rule.action, input.action) &&
              input.resources.some((resource) => matches(rule.resource, resource)),
          )
          .at(-1)?.effect;
        const evaluation: FakePermissionEvaluation = {
          sessionID: input.sessionID,
          agent: input.agent,
          action: input.action,
          resources: [...input.resources],
          effect: effect ?? "allow",
        };
        for (const callback of captures.permissionHooks.get("evaluate") ?? []) {
          await callback(evaluation);
        }
        if (evaluation.effect === "deny") {
          throw new Error(`permission denied: ${input.action}${evaluation.message ? ` — ${evaluation.message}` : ""}`);
        }
        await options.permissionAssert?.(input);
      },
      async hook(name, callback) {
        captureHook(captures.permissionHooks, name, callback);
        return register();
      },
    },
    storage,
    agent: {
      async list() {
        return agents;
      },
    },
    skill: {
      async list() {
        return { location: { directory: "/fake/project" }, data: skills };
      },
    },
    captures,
    createEditor,
    createCompactionEvent(overrides = {}) {
      return {
        sessionID: "ses_fake",
        model: "fake/model",
        system: [{ type: "text", text: "base system prompt" }],
        messages: [],
        options: {},
        agent: "build",
        tools: {},
        ...overrides,
      };
    },
    createContextEvent(overrides = {}) {
      return {
        sessionID: "ses_fake",
        model: "fake/model",
        system: [{ type: "text", text: "base system prompt" }],
        messages: [],
        options: {},
        agent: "build",
        tools: {},
        ...overrides,
      };
    },
  };
}
