import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "@runto/core";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  client?: Anthropic;
  costPerMillionTokens?: { input: number; output: number; cachedInput?: number };
}

function messagesForAnthropic(
  messages: ProviderMessage[],
  toolNameById: Map<string, string>,
  instructions?: string,
): {
  system?: string;
  messages: unknown[];
} {
  const system =
    [
      instructions,
      ...messages.filter((message) => message.role === "system").map((message) => message.content),
    ]
      .filter(Boolean)
      .join("\n") || undefined;
  const converted = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool")
        return {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
          ],
        };
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: toolNameById.get(call.toolId) ?? call.toolId,
              input: call.arguments,
            })),
          ],
        };
      }
      return { role: message.role, content: message.content };
    });
  return { ...(system ? { system } : {}), messages: converted };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  let client = options.client;
  return {
    name: "anthropic",
    model: options.model,
    costPerMillionTokens: options.costPerMillionTokens,
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      client ??= new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
      const toolNameById = new Map(request.tools.map((tool) => [tool.id, tool.name]));
      const input = messagesForAnthropic(request.messages, toolNameById, request.instructions);
      const response = await client.messages.create(
        {
          model: options.model,
          max_tokens: request.maxOutputTokens ?? options.maxTokens ?? 4_096,
          ...input,
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        } as never,
        { signal: request.signal },
      );
      const raw = response as unknown as {
        content?: Array<Record<string, unknown>>;
        usage?: Record<string, unknown>;
        stop_reason?: string;
      };
      const content = raw.content ?? [];
      return {
        text: content
          .filter((block) => block.type === "text")
          .map((block) => String(block.text ?? ""))
          .join(""),
        toolCalls: content
          .filter((block) => block.type === "tool_use")
          .map((block, index) => ({
            id: String(block.id ?? `anthropic-call-${index}`),
            toolId:
              new Map(request.tools.map((tool) => [tool.name, tool.id])).get(String(block.name)) ??
              String(block.name),
            arguments: block.input,
          })),
        usage: {
          inputTokens: Number(raw.usage?.input_tokens ?? 0),
          outputTokens: Number(raw.usage?.output_tokens ?? 0),
          cachedTokens: Number(raw.usage?.cache_read_input_tokens ?? 0),
        },
        finishReason: raw.stop_reason,
        raw: response,
      };
    },
    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      client ??= new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
      const toolNameById = new Map(request.tools.map((tool) => [tool.id, tool.name]));
      const toolIdByName = new Map(request.tools.map((tool) => [tool.name, tool.id]));
      const input = messagesForAnthropic(request.messages, toolNameById, request.instructions);
      const stream = await client.messages.create(
        {
          model: options.model,
          max_tokens: request.maxOutputTokens ?? options.maxTokens ?? 4_096,
          ...input,
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          stream: true,
        } as never,
        { signal: request.signal },
      );
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        if (event.type === "message_start") {
          const usage = (event.message as Record<string, unknown> | undefined)?.usage as
            | Record<string, unknown>
            | undefined;
          if (usage)
            yield {
              type: "usage",
              usage: { inputTokens: Number(usage.input_tokens ?? 0) },
            };
        } else if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use")
            toolBlocks.set(Number(event.index), {
              id: String(block.id),
              name: String(block.name),
              json:
                block.input && typeof block.input === "object"
                  ? JSON.stringify(block.input) === "{}"
                    ? ""
                    : JSON.stringify(block.input)
                  : "",
            });
        } else if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta")
            yield { type: "text-delta", text: String(delta.text ?? "") };
          else if (delta?.type === "thinking_delta")
            yield { type: "reasoning", data: delta.thinking };
          else if (delta?.type === "input_json_delta") {
            const block = toolBlocks.get(Number(event.index));
            if (block) block.json += String(delta.partial_json ?? "");
          }
        } else if (event.type === "content_block_stop") {
          const block = toolBlocks.get(Number(event.index));
          if (block) {
            yield {
              type: "tool-call",
              call: {
                id: block.id,
                toolId: toolIdByName.get(block.name) ?? block.name,
                arguments: JSON.parse(block.json || "{}"),
              },
            };
            toolBlocks.delete(Number(event.index));
          }
        } else if (event.type === "message_delta") {
          const usage = event.usage as Record<string, unknown> | undefined;
          if (usage)
            yield {
              type: "usage",
              usage: { outputTokens: Number(usage.output_tokens ?? 0) },
            };
          yield {
            type: "finish",
            reason:
              typeof event.delta === "object"
                ? String((event.delta as Record<string, unknown>).stop_reason ?? "")
                : undefined,
          };
        } else if (event.type === "error") {
          throw new Error(JSON.stringify(event.error ?? "Anthropic stream failed"));
        }
      }
    },
  };
}
