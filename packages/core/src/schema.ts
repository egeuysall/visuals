import type { JsonSchema } from "./types.js";

export interface CompiledSchema {
  original: JsonSchema;
  compact: JsonSchema;
  beforeTokens: number;
  afterTokens: number;
}

export function estimateSchemaTokens(schema: JsonSchema): number {
  return Math.max(1, Math.ceil(JSON.stringify(schema).length / 4));
}

function compactDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (
    /(must|never|do not|don't|required|permission|security|safety|secret|irreversible)/i.test(
      normalized,
    )
  )
    return normalized;
  return normalized.split(/(?<=[.!?])\s+/)[0] ?? normalized;
}

function compactNode(node: JsonSchema): JsonSchema {
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema" || key === "title") continue;
    if (key === "description" && typeof value === "string") {
      result[key] = compactDescription(value);
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [
          name,
          compactNode(child),
        ]),
      );
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      result[key] = compactNode(value as JsonSchema);
      continue;
    }
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      result[key] = value.map((child) =>
        child && typeof child === "object" ? compactNode(child as JsonSchema) : child,
      );
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function compileToolSchema(schema: JsonSchema): CompiledSchema {
  const compact = compactNode(schema);
  return {
    original: schema,
    compact,
    beforeTokens: estimateSchemaTokens(schema),
    afterTokens: estimateSchemaTokens(compact),
  };
}
