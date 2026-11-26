import { MemoryCacheAdapter } from "@runto/cache";
import {
  createMockProvider,
  createRuntime,
  type ProviderRequest,
  type RuntimeTool,
} from "@runto/core";
import { createVercelProvider } from "@runto/provider-vercel";
import { MemoryTelemetryExporter, Telemetry } from "@runto/telemetry";

const issueTool: RuntimeTool<{ issueId: string }, unknown> = {
  id: "github/get_issue",
  name: "github/get_issue",
  description: "Read a GitHub issue and its comments by issue identifier.",
  inputSchema: {
    type: "object",
    properties: { issueId: { type: "string", minLength: 1 } },
    required: ["issueId"],
    additionalProperties: false,
  },
  metadata: {
    server: "github",
    sideEffect: "read",
    idempotent: true,
    cachePolicy: { mode: "ttl", ttlMs: 60_000 },
  },
  async execute(input) {
    return {
      issueId: input.issueId,
      title: "Reconcile stale issue metadata",
      state: "open",
      likelyRootCause: "The sync worker accepts an old cursor after reconnect.",
      comments: Array.from({ length: 12 }, (_, index) => ({
        author: `engineer-${index}`,
        body: "The cursor is stale after reconnect.",
      })),
    };
  },
};

const events = new MemoryTelemetryExporter();
const telemetry = new Telemetry([events]);
let providerCalls = 0;
const mockProvider = createMockProvider((request: ProviderRequest) => {
  providerCalls += 1;
  if (providerCalls === 1)
    return {
      toolCalls: [
        {
          id: "search",
          toolId: "search_tools",
          arguments: { query: request.messages[0]?.content ?? "issue" },
        },
      ],
    };
  if (providerCalls === 2)
    return {
      toolCalls: [
        { id: "inspect", toolId: "inspect_tool", arguments: { toolId: "github/get_issue" } },
      ],
    };
  if (providerCalls === 3)
    return {
      toolCalls: [
        {
          id: "execute",
          toolId: "execute_tool",
          arguments: { toolId: "github/get_issue", arguments: { issueId: "ENG-142" } },
        },
      ],
    };
  return {
    text: "ENG-142 is most likely blocked by a stale reconnect cursor in the sync worker.",
    toolCalls: [],
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
  tools: [issueTool],
  telemetry,
  cache: new MemoryCacheAdapter(),
  projectId: "example-agent",
  environment: "local",
  optimizations: {
    toolDiscovery: { enabled: true, strategy: "bm25", topK: 3 },
    schemaCompiler: { enabled: true },
    contextCompiler: { enabled: true, tokenBudget: 500 },
    resultCompiler: { enabled: true, maxInlineBytes: 400 },
    cache: { enabled: true },
    parallelExecution: { enabled: true, maxConcurrency: 4 },
    speculation: { enabled: false, mode: "read-only" },
  },
});

const result = await runtime.run({
  task: "Investigate issue ENG-142 and identify the likely root cause.",
  ...(live
    ? {
        maxSteps: 6,
        signal: AbortSignal.timeout(Number(process.env.NAVO_RUN_TIMEOUT_MS ?? 120_000)),
      }
    : {}),
  context: [
    {
      source: "deploy-log",
      text: "The sync worker recently added reconnect handling.",
      confidence: 0.9,
    },
  ],
});

console.log(
  JSON.stringify(
    { output: result.output, metrics: result.metrics, events: events.events.length },
    null,
    2,
  ),
);
