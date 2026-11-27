import "server-only";
import type { Provider, ProviderMessage, ProviderRequest, ProviderResponse } from "@runto/core";
import { bindings } from "./cloudflare";

export const modelName = () => process.env.MODEL_NAME || "@cf/zai-org/glm-4.7-flash";

export const pricing = () => ({
  input: Number(process.env.MODEL_INPUT_COST_PER_MILLION || 0.0605),
  output: Number(process.env.MODEL_OUTPUT_COST_PER_MILLION || 0.4),
});

interface Completion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

function toChat(messages: ProviderMessage[], names: Map<string, string>) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: names.get(c.toolId) ?? c.toolId,
              arguments:
                typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
            },
          })),
        }
      : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }));
}

/** Stops waiting when the run is cancelled or times out. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A runtime provider over the Cloudflare Workers AI binding. */
export function workersAiProvider(thinking: boolean): Provider {
  return {
    name: "cloudflare-workers-ai",
    model: modelName(),
    costPerMillionTokens: pricing(),
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const names = new Map(request.tools.map((t) => [t.id, t.name]));
      const ids = new Map(request.tools.map((t) => [t.name, t.id]));
      const system = request.instructions
        ? [{ role: "system", content: request.instructions }]
        : [];
      const run = bindings().AI.run(modelName(), {
        messages: [...system, ...toChat(request.messages, names)],
        ...(request.tools.length
          ? {
              tools: request.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
              parallel_tool_calls: true,
              // Until something has been looked up, the model has to look things up. Left to
              // choose, it can answer from nothing and invent the facts.
              ...(request.messages.some((m) => m.role === "tool")
                ? {}
                : { tool_choice: "required" }),
            }
          : {}),
        max_tokens: Math.min(request.maxOutputTokens ?? 4096, 4096),
        chat_template_kwargs: { enable_thinking: thinking },
      });
      const output = (await abortable(run, request.signal)) as Completion;
      const choice = output.choices?.[0];
      if (!choice?.message) throw new Error("the model returned no message");
      return {
        text: choice.message.content ?? "",
        toolCalls: (choice.message.tool_calls ?? []).map((c) => ({
          id: c.id,
          toolId: ids.get(c.function.name) ?? c.function.name,
          arguments: c.function.arguments,
        })),
        usage: {
          inputTokens: output.usage?.prompt_tokens ?? 0,
          outputTokens: output.usage?.completion_tokens ?? 0,
          cachedTokens: output.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        finishReason: choice.finish_reason,
      };
    },
  };
}
