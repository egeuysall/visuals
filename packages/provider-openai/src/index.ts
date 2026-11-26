import type { Provider, ProviderRequest, ProviderResponse, ProviderStreamEvent } from "@runto/core";
import OpenAI from "openai";

export interface OpenAIProviderOptions {
  apiKey?: string;
  model: string;
  baseURL?: string;
  client?: OpenAI;
  costPerMillionTokens?: { input: number; output: number; cachedInput?: number };
}

function inputForResponses(request: ProviderRequest): unknown[] {
  const toolNameById = new Map(request.tools.map((tool) => [tool.id, tool.name]));
  return request.messages
    .filter((message) => message.role !== "system")
    .flatMap<unknown>((message) => {
      if (message.role === "tool")
        return {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        };
      if (message.role === "assistant" && message.toolCalls?.length) {
        return [
          ...(message.content ? [{ role: "assistant", content: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "function_call",
            call_id: call.id,
            name: toolNameById.get(call.toolId) ?? call.toolId,
            arguments: JSON.stringify(call.arguments),
          })),
        ];
      }
      return [{ role: message.role, content: message.content }];
    });
}

export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  let client = options.client;
  return {
    name: "openai",
    model: options.model,
    costPerMillionTokens: options.costPerMillionTokens,
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      client ??= new OpenAI({
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
        baseURL: options.baseURL,
      });
      const response = await client.responses.create(
        {
          model: options.model,
          ...(request.maxOutputTokens !== undefined
            ? { max_output_tokens: request.maxOutputTokens }
            : {}),
          ...(() => {
            const instructions = [
              request.instructions,
              ...request.messages
                .filter((message) => message.role === "system")
                .map((message) => message.content),
            ].filter(Boolean);
            return instructions.length ? { instructions: instructions.join("\n\n") } : {};
          })(),
          input: inputForResponses(request),
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        } as never,
        { signal: request.signal },
      );
      const raw = response as unknown as {
        output_text?: string;
        output?: Array<Record<string, unknown>>;
        usage?: Record<string, unknown>;
      };
      const toolIdByName = new Map(request.tools.map((tool) => [tool.name, tool.id]));
      const toolCalls = (raw.output ?? [])
        .filter((item) => item.type === "function_call")
        .map((item, index) => ({
          id: String(item.call_id ?? `openai-call-${index}`),
          toolId: toolIdByName.get(String(item.name)) ?? String(item.name),
          arguments:
            typeof item.arguments === "string"
              ? (JSON.parse(item.arguments) as unknown)
              : item.arguments,
        }));
      const usage = raw.usage;
      const details = usage?.input_tokens_details as Record<string, unknown> | undefined;
      return {
        text: raw.output_text ?? "",
        toolCalls,
        usage: {
          inputTokens: Number(usage?.input_tokens ?? 0),
          outputTokens: Number(usage?.output_tokens ?? 0),
          cachedTokens: Number(details?.cached_tokens ?? 0),
        },
        raw: response,
      };
    },
    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      client ??= new OpenAI({
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
        baseURL: options.baseURL,
      });
      const stream = await client.responses.create(
        {
          model: options.model,
          input: inputForResponses(request),
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
          stream: true,
        } as never,
        { signal: request.signal },
      );
      const toolIdByName = new Map(request.tools.map((tool) => [tool.name, tool.id]));
      const namesByCallId = new Map<string, string>();
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text-delta", text: String(event.delta ?? "") };
        } else if (event.type === "response.output_item.added") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const callId = String(item.call_id ?? item.id ?? "");
            namesByCallId.set(callId, String(item.name ?? ""));
          }
        } else if (event.type === "response.function_call_arguments.done") {
          const callId = String(event.call_id ?? event.item_id ?? "");
          const name = namesByCallId.get(callId) ?? String(event.name ?? "");
          const rawArguments = event.arguments;
          yield {
            type: "tool-call",
            call: {
              id: callId,
              toolId: toolIdByName.get(name) ?? name,
              arguments: typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments,
            },
          };
        } else if (event.type === "response.reasoning_summary_text.delta") {
          yield { type: "reasoning", data: event.delta };
        } else if (event.type === "response.completed") {
          const response = event.response as Record<string, unknown> | undefined;
          const usage = response?.usage as Record<string, unknown> | undefined;
          if (usage)
            yield {
              type: "usage",
              usage: {
                inputTokens: Number(usage.input_tokens ?? 0),
                outputTokens: Number(usage.output_tokens ?? 0),
                cachedTokens: Number(
                  (usage.input_tokens_details as Record<string, unknown> | undefined)
                    ?.cached_tokens ?? 0,
                ),
              },
            };
          yield { type: "finish", reason: String(response?.status ?? "completed") };
        } else if (event.type === "response.failed") {
          throw new Error(
            JSON.stringify(event.response ?? event.error ?? "OpenAI response failed"),
          );
        }
      }
    },
  };
}
