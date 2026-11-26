import {
  createMockProvider,
  createRuntime,
  type ProviderRequest,
  type RuntimeTool,
} from "@runto/core";
import { createVercelProvider } from "@runto/provider-vercel";

const issue: RuntimeTool = {
  id: "tracker/get-issue",
  name: "get_issue",
  description: "Read an issue by its identifier.",
  inputSchema: {
    type: "object",
    properties: { issueId: { type: "string", minLength: 1 } },
    required: ["issueId"],
    additionalProperties: false,
  },
  metadata: { sideEffect: "read", idempotent: true },
  async execute(input) {
    return { id: (input as { issueId: string }).issueId, status: "open" };
  },
};

const changes: RuntimeTool = {
  id: "git/list-changes",
  name: "list_changes",
  description: "List recent changes related to an issue.",
  inputSchema: {
    type: "object",
    properties: { issueId: { type: "string", minLength: 1 } },
    required: ["issueId"],
    additionalProperties: false,
  },
  metadata: { sideEffect: "read", idempotent: true },
  async execute(input) {
    return { issueId: (input as { issueId: string }).issueId, changes: ["commit-1"] };
  },
};

const mockProvider = createMockProvider((request: ProviderRequest) => {
  if (!request.messages.some((message) => message.role === "tool"))
    return {
      toolCalls: [
        { id: "issue-1", toolId: issue.id, arguments: { issueId: "ENG-142" } },
        { id: "changes-1", toolId: changes.id, arguments: { issueId: "ENG-142" } },
      ],
    };
  return { text: "ENG-142 is open and has one related change.", toolCalls: [] };
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
  tools: [issue, changes],
  optimizations: { parallelExecution: { enabled: true, maxConcurrency: 2 } },
});

console.log(
  await runtime.run({
    task: "Investigate issue ENG-142 using both get_issue and list_changes, then summarize.",
    ...(live
      ? {
          maxSteps: 3,
          signal: AbortSignal.timeout(Number(process.env.NAVO_RUN_TIMEOUT_MS ?? 60_000)),
        }
      : {}),
  }),
);
