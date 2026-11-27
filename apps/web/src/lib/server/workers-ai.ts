import "server-only";
import type { Provider, ProviderMessage, ProviderRequest, ProviderResponse } from "@runto/core";

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

/** A runtime provider over apps/model, the Cloudflare Workers AI worker. */
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
      const url = `${process.env.MODEL_URL || "http://127.0.0.1:8787"}/run`;
      const token = process.env.MODEL_PROXY_TOKEN;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            messages: [...system, ...toChat(request.messages, names)],
            tools: request.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            max_tokens: request.maxOutputTokens ?? 4096,
            thinking,
          }),
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new Error(
          "the model worker is not reachable. start it: pnpm --filter visuals-model dev",
        );
      }
      if (!res.ok)
        throw new Error(`model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const { output } = (await res.json()) as { output: Completion };
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
