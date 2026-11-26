import type { ProviderMessage, ProviderToolDefinition, RuntimeTool, ToolCall } from "@runto/core";
import { jsonSchema } from "ai";

export interface VercelToolDefinition {
  description: string;
  inputSchema: unknown;
}

export function toVercelTool(tool: RuntimeTool): VercelToolDefinition {
  return { description: tool.description, inputSchema: jsonSchema(tool.inputSchema as never) };
}

export function toVercelTools(
  tools: ProviderToolDefinition[],
): Record<string, VercelToolDefinition> {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      { description: tool.description, inputSchema: jsonSchema(tool.inputSchema as never) },
    ]),
  );
}

export function toVercelMessages(
  messages: ProviderMessage[],
  toolNameById?: Map<string, string>,
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.id,
            toolName: toolNameById?.get(call.toolId) ?? call.toolId,
            input: call.arguments,
          })),
        ],
      };
    }
    if (message.role === "tool") {
      let output: unknown = message.content;
      try {
        output = JSON.parse(message.content) as unknown;
      } catch {
        /* keep text output */
      }
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: toolNameById?.get(message.name ?? "") ?? message.name ?? "unknown",
            output: { type: typeof output === "string" ? "text" : "json", value: output },
          },
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function fromVercelToolCall(
  call: Record<string, unknown>,
  index: number,
  toolIdByName?: Map<string, string>,
): ToolCall {
  const toolName = String(call.toolName ?? call.name);
  return {
    id: String(call.toolCallId ?? call.id ?? `vercel-call-${index}`),
    toolId: toolIdByName?.get(toolName) ?? toolName,
    arguments: call.input ?? call.args ?? call.arguments,
  };
}
