import {
  createMockProvider,
  createRuntime,
  type ProviderRequest,
  type RuntimeTool,
} from "@runto/core";
import { createVercelProvider } from "@runto/provider-vercel";

const searchDocs: RuntimeTool = {
  id: "docs/search",
  name: "search_docs",
  description: "Search product documentation for a question.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
  metadata: { sideEffect: "read", idempotent: true },
  async execute(input) {
    return { answer: `Documentation result for ${(input as { query: string }).query}` };
  },
};

const mockProvider = createMockProvider((request: ProviderRequest) => {
  const hasToolResult = request.messages.some((message) => message.role === "tool");
  return hasToolResult
    ? { text: "The documentation confirms the requested behavior.", toolCalls: [] }
    : {
        toolCalls: [
          {
            id: "search-1",
            toolId: "docs/search",
            arguments: { query: request.messages.at(-1)?.content ?? "" },
          },
        ],
      };
});

const provider = process.env.AI_GATEWAY_API_KEY
  ? createVercelProvider({
      model: process.env.AI_GATEWAY_MODEL ?? "openai/gpt-5",
      apiKey: process.env.AI_GATEWAY_API_KEY,
      gateway: true,
    })
  : mockProvider;
const live = Boolean(process.env.AI_GATEWAY_API_KEY);

const runtime = createRuntime({
  provider,
  tools: [searchDocs],
  optimizations: {
    toolDiscovery: false,
    schemaCompiler: true,
    resultCompiler: true,
    cache: true,
  },
});

console.log(
  await runtime.run({
    task: live
      ? "Use search_docs exactly once for the query issue search, then summarize the result."
      : "Research how issue search works",
    ...(live
      ? {
          maxSteps: 3,
          signal: AbortSignal.timeout(Number(process.env.NAVO_RUN_TIMEOUT_MS ?? 60_000)),
        }
      : {}),
  }),
);
