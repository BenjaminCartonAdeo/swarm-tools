/**
 * Deterministic OpenAI-compatible chat-completions server (Task 19).
 *
 * Scripted per conversation: a user turn containing `RUN_SHELL` gets a call to
 * the built-in `shell` tool, any other user turn gets a `hive_ready` call. Once
 * the conversation ends with a tool result, the server answers with final text.
 * Requests without tools (titles, summaries) receive a short text answer.
 * Every request body is kept in `requests` for diagnostics.
 */
export interface FakeOpenAIServer {
  readonly url: string;
  readonly requests: unknown[];
  stop(): Promise<void>;
}

export const SHELL_TRIGGER = "RUN_SHELL";
export const SHELL_MARKER = "shell-hook-marker-41c9";
export const FINAL_TEXT = "fake-model-final-answer";

type Message = { role?: string; content?: unknown };
type ToolDef = { type?: string; function?: { name?: string; parameters?: unknown } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function usage(): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })}\n\n`;
}

function sse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function textStream(text: string): Response {
  return sse(
    chunk({ role: "assistant", content: text }) + chunk({}, "stop") + usage() + "data: [DONE]\n\n",
  );
}

function toolStream(name: string, args: Record<string, unknown>, callId: string): Response {
  return sse(
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }) +
      chunk({}, "tool_calls") +
      usage() +
      "data: [DONE]\n\n",
  );
}

/** Builds `shell` arguments from the schema the host advertised. */
function shellArgs(tools: ToolDef[]): Record<string, unknown> {
  const shell = tools.find((tool) => tool.function?.name === "shell");
  const params = shell?.function?.parameters as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const args: Record<string, unknown> = { command: `echo ${SHELL_MARKER}` };
  for (const key of params?.required ?? []) {
    if (key in args) continue;
    if (key === "description") args[key] = "Print the hook marker";
    else if (key === "timeout") args[key] = 10_000;
  }
  if (params?.properties && "description" in params.properties && !("description" in args)) {
    args.description = "Print the hook marker";
  }
  return args;
}

export function startFakeOpenAIServer(): FakeOpenAIServer {
  const requests: unknown[] = [];
  let calls = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "smoke", object: "model", owned_by: "local" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const body = (await request.json()) as { messages?: Message[]; tools?: ToolDef[] };
      requests.push(body);
      const messages = body.messages ?? [];
      const tools = body.tools ?? [];
      const last = messages.at(-1);

      if (tools.length === 0) return textStream("Smoke session");
      if (last?.role === "tool") return textStream(FINAL_TEXT);

      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      calls += 1;
      if (textOf(lastUser?.content).includes(SHELL_TRIGGER)) {
        return toolStream("shell", shellArgs(tools), `call_shell_${calls}`);
      }
      return toolStream("hive_ready", {}, `call_hive_${calls}`);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    async stop() {
      await server.stop(true);
    },
  };
}
