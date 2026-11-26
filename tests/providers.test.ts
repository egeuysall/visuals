import { toVercelMessages } from "@runto/adapter-vercel-ai";
import { createAnthropicProvider } from "@runto/provider-anthropic";
import { createOpenAIProvider } from "@runto/provider-openai";
import { createVercelProvider } from "@runto/provider-vercel";
import { describe, expect, it } from "vitest";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

const toolRequest = {
  messages: [{ role: "user" as const, content: "find" }],
  tools: [
    {
      id: "crm/lookup",
      name: "lookup",
      description: "Look up a customer",
      inputSchema: { type: "object" },
    },
  ],
};

describe("provider normalization", () => {
  it("preserves structured calls and tool results for Vercel AI", () => {
    const messages = toVercelMessages([
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", toolId: "lookup", arguments: { key: "x" } }],
      },
      { role: "tool", name: "lookup", toolCallId: "c1", content: JSON.stringify({ ok: true }) },
    ]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup" }],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "lookup",
          output: { type: "json", value: { ok: true } },
        },
      ],
    });
  });

  it("normalizes direct OpenAI Responses output", async () => {
    const provider = createOpenAIProvider({
      model: "gpt-5",
      apiKey: "test",
      client: {
        responses: {
          create: async () => ({
            output_text: "ok",
            output: [
              { type: "function_call", call_id: "c1", name: "lookup", arguments: '{"key":"x"}' },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 1 },
            },
          }),
        },
      } as never,
    });
    const response = await provider.generate({
      messages: [{ role: "user", content: "find" }],
      tools: [
        {
          id: "crm/lookup",
          name: "lookup",
          description: "Look up a customer",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(response.text).toBe("ok");
    expect(response.toolCalls?.[0]).toEqual({
      id: "c1",
      toolId: "crm/lookup",
      arguments: { key: "x" },
    });
    expect(response.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, cachedTokens: 1 });
  });

  it("normalizes direct Anthropic Messages output", async () => {
    const provider = createAnthropicProvider({
      model: "claude-sonnet-4-5",
      apiKey: "test",
      client: {
        messages: {
          create: async () => ({
            content: [
              { type: "text", text: "ok" },
              { type: "tool_use", id: "c1", name: "lookup", input: { key: "x" } },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
            stop_reason: "tool_use",
          }),
        },
      } as never,
    });
    const response = await provider.generate({
      messages: [{ role: "user", content: "find" }],
      tools: [
        {
          id: "crm/lookup",
          name: "lookup",
          description: "Look up a customer",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(response.text).toBe("ok");
    expect(response.toolCalls?.[0]).toEqual({
      id: "c1",
      toolId: "crm/lookup",
      arguments: { key: "x" },
    });
    expect(response.finishReason).toBe("tool_use");
  });

  it("adapts Vercel SDK output through an injectable generator", async () => {
    const provider = createVercelProvider({
      model: "openai/gpt-5",
      modelFactory: (model) => ({ model }),
      generateText: async (options) => ({
        text: "ok",
        toolCalls: [{ toolCallId: "c1", toolName: "lookup", input: { key: "x" } }],
        usage: { inputTokens: 2, outputTokens: 3 },
        raw: options,
      }),
    });
    const response = await provider.generate({
      messages: [{ role: "user", content: "find" }],
      tools: [
        {
          id: "crm/lookup",
          name: "lookup",
          description: "Look up a customer",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(response.text).toBe("ok");
    expect(response.toolCalls?.[0]).toEqual({
      id: "c1",
      toolId: "crm/lookup",
      arguments: { key: "x" },
    });
  });

  it("passes instructions separately from Vercel Gateway messages", async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = createVercelProvider({
      model: "openai/gpt-5",
      modelFactory: (model) => ({ model }),
      generateText: async (options) => {
        captured = options;
        return { text: "ok", toolCalls: [] };
      },
    });

    await provider.generate({
      instructions: "Batch independent reads.",
      messages: [
        { role: "system", content: "Context" },
        { role: "user", content: "find" },
      ],
      tools: [],
    });

    expect(captured).toMatchObject({ instructions: "Batch independent reads.\n\nContext" });
    expect(captured?.messages).toEqual([{ role: "user", content: "find" }]);
  });

  it("passes provider-native generation controls to Vercel AI", async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = createVercelProvider({
      model: "openai/gpt-5",
      modelFactory: (model) => ({ model }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      maxOutputTokens: 2_000,
      generateText: async (options) => {
        captured = options;
        return { text: "ok", toolCalls: [] };
      },
    });

    await provider.generate({ ...toolRequest, maxOutputTokens: 512 });

    expect(captured).toMatchObject({
      providerOptions: { openai: { reasoningEffort: "low" } },
      maxOutputTokens: 512,
    });
  });

  it("uses the Vercel AI Gateway when requested", async () => {
    let model: Record<string, unknown> | undefined;
    const provider = createVercelProvider({
      model: "openai/gpt-5",
      apiKey: "test-gateway-key",
      gateway: true,
      generateText: async (options) => {
        model = options.model as Record<string, unknown>;
        return { text: "ok", toolCalls: [] };
      },
    });

    await provider.generate(toolRequest);

    expect(model).toMatchObject({ provider: "gateway", modelId: "openai/gpt-5" });
  });

  it("defaults to the Vercel AI Gateway when its key is present", async () => {
    const previousKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
    try {
      let model: Record<string, unknown> | undefined;
      const provider = createVercelProvider({
        model: "openai/gpt-5",
        generateText: async (options) => {
          model = options.model as Record<string, unknown>;
          return { text: "ok", toolCalls: [] };
        },
      });

      await provider.generate(toolRequest);

      expect(model).toMatchObject({ provider: "gateway", modelId: "openai/gpt-5" });
    } finally {
      if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previousKey;
    }
  });

  it("normalizes provider-native streaming events", async () => {
    const openai = createOpenAIProvider({
      model: "gpt-5",
      client: {
        responses: {
          create: async (input: Record<string, unknown>) =>
            input.stream
              ? (async function* () {
                  yield {
                    type: "response.output_text.delta",
                    delta: "ok",
                  };
                  yield {
                    type: "response.output_item.added",
                    item: { type: "function_call", call_id: "c1", name: "lookup" },
                  };
                  yield {
                    type: "response.function_call_arguments.done",
                    call_id: "c1",
                    arguments: '{"key":"x"}',
                  };
                  yield {
                    type: "response.completed",
                    response: {
                      status: "completed",
                      usage: { input_tokens: 2, output_tokens: 3 },
                    },
                  };
                })()
              : ({ output_text: "ok", output: [] } as never),
        },
      } as never,
    });
    const openaiEvents = await collect(openai.stream?.(toolRequest) ?? (async function* () {})());
    expect(openaiEvents).toEqual([
      { type: "text-delta", text: "ok" },
      {
        type: "tool-call",
        call: { id: "c1", toolId: "crm/lookup", arguments: { key: "x" } },
      },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3, cachedTokens: 0 } },
      { type: "finish", reason: "completed" },
    ]);

    const anthropic = createAnthropicProvider({
      model: "claude-sonnet-4-5",
      client: {
        messages: {
          create: async (input: Record<string, unknown>) =>
            input.stream
              ? (async function* () {
                  yield { type: "message_start", message: { usage: { input_tokens: 2 } } };
                  yield {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "tool_use", id: "c1", name: "lookup", input: {} },
                  };
                  yield {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "input_json_delta", partial_json: '{"key":"x"}' },
                  };
                  yield { type: "content_block_stop", index: 0 };
                  yield {
                    type: "message_delta",
                    delta: { stop_reason: "tool_use" },
                    usage: { output_tokens: 3 },
                  };
                })()
              : ({ content: [], usage: {} } as never),
        },
      } as never,
    });
    const anthropicEvents = await collect(
      anthropic.stream?.(toolRequest) ?? (async function* () {})(),
    );
    expect(anthropicEvents).toEqual([
      { type: "usage", usage: { inputTokens: 2 } },
      {
        type: "tool-call",
        call: { id: "c1", toolId: "crm/lookup", arguments: { key: "x" } },
      },
      { type: "usage", usage: { outputTokens: 3 } },
      { type: "finish", reason: "tool_use" },
    ]);

    const vercel = createVercelProvider({
      model: "openai/gpt-5",
      modelFactory: (model) => ({ model }),
      streamText: async () => ({
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" };
          yield { type: "reasoning-delta", delta: "because" };
          yield { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { key: "x" } };
          yield {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 2, outputTokens: 3 },
          };
        })(),
      }),
    });
    const vercelEvents = await collect(vercel.stream?.(toolRequest) ?? (async function* () {})());
    expect(vercelEvents).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "reasoning", data: "because" },
      {
        type: "tool-call",
        call: { id: "c1", toolId: "crm/lookup", arguments: { key: "x" } },
      },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3, cachedTokens: 0 } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });
});
