import type {
  ReadOnlyToolPlan,
  RuntimeTool,
  ToolCall,
  ToolDependencyResolver,
  ToolRegistry,
} from "./types.js";

const reference = /\$call:([A-Za-z0-9_:-]+)(?:\.[A-Za-z0-9_.-]+)?/g;

function collectReferences(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(reference)) output.add(match[1] ?? "");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferences(item, output);
  }
}

export function inferToolDependencies(
  calls: ToolCall[],
  tools: ToolRegistry,
  resolver?: ToolDependencyResolver,
): ReadonlyMap<string, string[]> {
  if (resolver) return resolver(calls, tools);
  const ids = new Set(calls.map((call) => call.id));
  return new Map(
    calls.map((call) => {
      const dependencies = new Set<string>();
      collectReferences(call.arguments, dependencies);
      dependencies.delete(call.id);
      return [call.id, [...dependencies].filter((id) => ids.has(id))];
    }),
  );
}

function getPath(value: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );
}

function resolve(value: unknown, results: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\$call:([A-Za-z0-9_:-]+)(?:\.([A-Za-z0-9_.-]+))?$/.exec(value);
    if (exact) {
      const result = results.get(exact[1] ?? "");
      return exact[2] ? getPath(result, exact[2].split(".")) : result;
    }
    return value.replaceAll(
      /\$call:([A-Za-z0-9_:-]+)(?:\.([A-Za-z0-9_.-]+))?/g,
      (match, id: string, property?: string) => {
        const result = results.get(id);
        const selected = property ? getPath(result, property.split(".")) : result;
        return selected === undefined ? match : JSON.stringify(selected);
      },
    );
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, results));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolve(item, results)]),
    );
  return value;
}

export function resolveToolCallArguments(
  value: unknown,
  results: ReadonlyMap<string, unknown>,
): unknown {
  return resolve(value, results);
}

export function createReadOnlyPlan(
  calls: ToolCall[],
  tools: ToolRegistry,
  resolver?: ToolDependencyResolver,
): ReadOnlyToolPlan[] {
  const dependencies = inferToolDependencies(calls, tools, resolver);
  return calls.map((call) => ({
    id: call.id,
    toolId: call.toolId,
    input: call.arguments,
    dependsOn: dependencies.get(call.id) ?? [],
  }));
}

export function isReadOnlyTool(tool: RuntimeTool | undefined): boolean {
  return Boolean(
    tool && (tool.metadata.sideEffect === "none" || tool.metadata.sideEffect === "read"),
  );
}
