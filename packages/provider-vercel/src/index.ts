import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { fromVercelToolCall, toVercelMessages, toVercelTools } from "@runto/adapter-vercel-ai";
import type { Provider, ProviderRequest, ProviderResponse, ProviderStreamEvent } from "@runto/core";
import { createGateway, generateText, streamText } from "ai";

export interface VercelProviderOptions {
  model: string | unknown;
  apiKey?: string;
  /** Route model requests through Vercel AI Gateway instead of a direct provider SDK. */
  gateway?: boolean;
  /** Provider-native generation options, for example OpenAI reasoningEffort. */
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  costPerMillionTokens?: Provider["costPerMillionTokens"];
  generateText?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  streamText?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  modelFactory?: (model: string, apiKey?: string) => unknown;
}

function resolveModel(
  model: string | unknown,
  apiKey?: string,
  modelFactory?: VercelProviderOptions["modelFactory"],
  gateway = false,
): unknown {
  if (typeof model !== "string") return model;
  if (modelFactory) return modelFactory(model, apiKey);
  if (gateway) return createGateway(apiKey ? { apiKey } : {})(model as never);
  const [vendor, rawName] = model.includes("/") ? model.split(/\/(.*)/s) : ["openai", model];
  const name = rawName ?? model;
  if (vendor === "openai") return createOpenAI({ apiKey })(name as never);
  if (vendor === "anthropic") return createAnthropic({ apiKey })(name as never);
  throw new Error(`Unsupported Vercel AI model vendor: ${vendor}`);
}

export function createVercelProvider(options: VercelProviderOptions): Provider {
  const modelName = typeof options.model === "string" ? options.model : "vercel-model";
  const runGenerateText =
    options.generateText ?? (generateText as unknown as VercelProviderOptions["generateText"]);
  const runStreamText =
    options.streamText ?? (streamText as unknown as VercelProviderOptions["streamText"]);
  const useGateway = options.gateway ?? Boolean(process.env.AI_GATEWAY_API_KEY);
  const promptFor = (request: ProviderRequest): string | undefined => {
    const parts = [
      request.instructions,
      ...request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    ].filter(Boolean);
    return parts.length ? parts.join("\n\n") : undefined;
  };
  const messagesFor = (request: ProviderRequest) =>
    toVercelMessages(
      request.messages.filter((message) => message.role !== "system"),
      new Map(request.tools.map((tool) => [tool.id, tool.name])),
    );
  return {
    name: "vercel-ai",
    model: modelName,
    ...(options.costPerMillionTokens ? { costPerMillionTokens: options.costPerMillionTokens } : {}),
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      if (!runGenerateText) throw new Error("Vercel AI SDK generateText is unavailable");
      const toolIdByName = new Map(request.tools.map((tool) => [tool.name, tool.id]));
      const result = await runGenerateText({
        model: resolveModel(options.model, options.apiKey, options.modelFactory, useGateway),
        messages: messagesFor(request),
        tools: toVercelTools(request.tools),
        ...(promptFor(request) ? { instructions: promptFor(request) } : {}),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
        ...((request.maxOutputTokens ?? options.maxOutputTokens) !== undefined
          ? { maxOutputTokens: request.maxOutputTokens ?? options.maxOutputTokens }
          : {}),
        abortSignal: request.signal,
      });
      const rawCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      return {
        text: typeof result.text === "string" ? result.text : "",
        toolCalls: rawCalls.map((call, index) =>
          fromVercelToolCall(call as Record<string, unknown>, index, toolIdByName),
        ),
        usage: {
          inputTokens: Number(
            (result.usage as Record<string, unknown> | undefined)?.inputTokens ?? 0,
          ),
          outputTokens: Number(
            (result.usage as Record<string, unknown> | undefined)?.outputTokens ?? 0,
          ),
          cachedTokens: Number(
            (result.usage as Record<string, unknown> | undefined)?.cachedInputTokens ?? 0,
          ),
        },
        finishReason: typeof result.finishReason === "string" ? result.finishReason : undefined,
        reasoning: result.reasoning,
        raw: result,
      };
    },
    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      if (!runStreamText) throw new Error("Vercel AI SDK streamText is unavailable");
      const toolIdByName = new Map(request.tools.map((tool) => [tool.name, tool.id]));
      const result = await runStreamText({
        model: resolveModel(options.model, options.apiKey, options.modelFactory, useGateway),
        messages: messagesFor(request),
        tools: toVercelTools(request.tools),
        ...(promptFor(request) ? { instructions: promptFor(request) } : {}),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
        ...((request.maxOutputTokens ?? options.maxOutputTokens) !== undefined
          ? { maxOutputTokens: request.maxOutputTokens ?? options.maxOutputTokens }
          : {}),
        abortSignal: request.signal,
      });
      const stream = result.fullStream as AsyncIterable<Record<string, unknown>> | undefined;
      if (!stream) throw new Error("Vercel AI stream did not expose fullStream");
      for await (const event of stream) {
        if (event.type === "text-delta") {
          const text = event.text ?? event.textDelta ?? event.delta;
          if (typeof text === "string") yield { type: "text-delta", text };
        } else if (event.type === "reasoning-delta") {
          yield { type: "reasoning", data: event.delta ?? event.textDelta ?? event.text };
        } else if (event.type === "tool-call") {
          yield { type: "tool-call", call: fromVercelToolCall(event, 0, toolIdByName) };
        } else if (event.type === "finish") {
          const usage = event.usage as Record<string, unknown> | undefined;
          if (usage)
            yield {
              type: "usage",
              usage: {
                inputTokens: Number(usage.inputTokens ?? 0),
                outputTokens: Number(usage.outputTokens ?? 0),
                cachedTokens: Number(usage.cachedInputTokens ?? 0),
              },
            };
          yield {
            type: "finish",
            reason: typeof event.finishReason === "string" ? event.finishReason : undefined,
          };
        } else if (event.type === "error") {
          throw event.error instanceof Error ? event.error : new Error(String(event.error));
        }
      }
    },
  };
}
