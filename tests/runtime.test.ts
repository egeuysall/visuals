import { MemoryCacheAdapter } from "@runto/cache";
import { compileContext } from "@runto/context";
import {
  createMockProvider,
  createRuntime,
  MemoryResultCompiler,
  type ProviderRequest,
  type RuntimeTool,
  validateToolInput,
} from "@runto/core";
import { MemoryTelemetryExporter, Telemetry } from "@runto/telemetry";
import { describe, expect, it } from "vitest";

function tool(execute: RuntimeTool["execute"] = async (input) => input): RuntimeTool {
  return {
    id: "lookup",
    name: "lookup",
    description: "Look up a record by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", minLength: 1 } },
      required: ["key"],
      additionalProperties: false,
    },
    metadata: { sideEffect: "read", idempotent: true, cachePolicy: { mode: "ttl", ttlMs: 10_000 } },
    execute,
  };
}

describe("runtime vertical slice", () => {
  it("runs the control path and records model/tool boundaries", async () => {
    const events = new MemoryTelemetryExporter();
    let calls = 0;
    const provider = createMockProvider((request: ProviderRequest) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "done", toolCalls: [] }
        : { toolCalls: [{ id: "call-1", toolId: "lookup", arguments: { key: "ENG-142" } }] },
    );
    const runtime = createRuntime({
      provider,
      tools: [
        tool(async (input) => {
          calls += 1;
          return { input, result: "root cause" };
        }),
      ],
      telemetry: new Telemetry([events]),
      optimizations: { cache: false, parallelExecution: false },
    });
    const result = await runtime.run({ task: "Find ENG-142" });
    expect(result.output).toBe("done");
    expect(calls).toBe(1);
    expect(result.metrics.assignment).toBe("control");
    expect(events.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.started",
        "model.started",
        "tool.started",
        "tool.completed",
        "run.completed",
      ]),
    );
  });

  it("guides independent reads into one batch and records phase timings", async () => {
    let firstRequest: ProviderRequest | undefined;
    const secondTool = { ...tool(), id: "lookup-two", name: "lookup-two" };
    const provider = createMockProvider((request) => {
      firstRequest ??= request;
      return request.messages.some((message) => message.role === "tool")
        ? { text: "done", toolCalls: [] }
        : {
            toolCalls: [
              { id: "call-1", toolId: "lookup", arguments: { key: "ENG-142" } },
              { id: "call-2", toolId: secondTool.id, arguments: { key: "ENG-142" } },
            ],
          };
    });
    const runtime = createRuntime({
      provider,
      tools: [tool(), secondTool],
      optimizations: {
        parallelExecution: {
          enabled: true,
          maxConcurrency: 2,
          promptGuidance: true,
          planningOutputTokens: 768,
        },
      },
    });

    const result = await runtime.run({ task: "Read both independent records" });

    expect(firstRequest?.instructions).toContain("request all of those tool calls");
    expect(firstRequest?.maxOutputTokens).toBe(768);
    expect(result.metrics.parallelGroupCount).toBe(1);
    expect(result.metrics.parallelToolCalls).toBe(2);
    expect(result.metrics.modelDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.toolDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("executes an explicit read-only plan before one synthesis call", async () => {
    const secondTool = { ...tool(), id: "lookup-two", name: "lookup-two" };
    const provider = createMockProvider((request) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "done", toolCalls: [] }
        : { text: "unexpected", toolCalls: [] },
    );
    const runtime = createRuntime({
      provider,
      tools: [tool(), secondTool],
      optimizations: { parallelExecution: { enabled: true, maxConcurrency: 2 } },
    });

    const result = await runtime.run({
      task: "Synthesize both records",
      maxSteps: 1,
      readOnlyPlan: [
        { id: "planned-one", toolId: "lookup", input: { key: "ENG-142" } },
        { id: "planned-two", toolId: secondTool.id, input: { key: "ENG-142" } },
      ],
    });

    expect(result.output).toBe("done");
    expect(result.metrics.modelCalls).toBe(1);
    expect(result.metrics.toolCalls).toBe(2);
    expect(result.metrics.parallelGroupCount).toBe(1);

    const writeTool = {
      ...secondTool,
      id: "write-record",
      metadata: { sideEffect: "write" as const, idempotent: false },
    };
    const unsafeRuntime = createRuntime({
      provider,
      tools: [writeTool],
      optimizations: { parallelExecution: true },
    });
    await expect(
      unsafeRuntime.run({
        task: "Do not write",
        readOnlyPlan: [{ id: "unsafe", toolId: writeTool.id, input: { key: "ENG-142" } }],
      }),
    ).rejects.toThrow("Read-only plan rejected");
  });

  it("discovers, inspects, executes, compacts, and caches without weakening validation", async () => {
    const events = new MemoryTelemetryExporter();
    const cache = new MemoryCacheAdapter();
    let executions = 0;
    const provider = createMockProvider((request) => {
      const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
      if (!lastTool)
        return {
          toolCalls: [
            { id: "search", toolId: "search_tools", arguments: { query: "lookup record" } },
          ],
        };
      if (lastTool.name === "search_tools")
        return {
          toolCalls: [{ id: "inspect", toolId: "inspect_tool", arguments: { toolId: "lookup" } }],
        };
      if (lastTool.name === "inspect_tool")
        return {
          toolCalls: [
            {
              id: "execute",
              toolId: "execute_tool",
              arguments: { toolId: "lookup", arguments: { key: "ENG-142" } },
            },
          ],
        };
      return { text: "The record is healthy.", toolCalls: [] };
    });
    const runtime = createRuntime({
      provider,
      tools: [
        tool(async () => {
          executions += 1;
          return { rows: Array.from({ length: 100 }, (_, index) => ({ index, value: "large" })) };
        }),
      ],
      cache,
      telemetry: new Telemetry([events]),
      optimizations: {
        toolDiscovery: { enabled: true, strategy: "bm25", topK: 3 },
        schemaCompiler: true,
        resultCompiler: { enabled: true, maxInlineBytes: 100 },
        cache: true,
        contextCompiler: true,
        parallelExecution: true,
      },
    });
    const result = await runtime.run({ task: "Find the lookup record" });
    expect(result.output).toContain("healthy");
    expect(result.metrics.inspectedTools).toContain("lookup");
    expect(result.metrics.executedTools).toContain("lookup");
    expect(events.events.some((event) => event.type === "result.compiled")).toBe(true);
    expect(executions).toBe(1);
    await runtime.run({ task: "Find the lookup record" });
    expect(executions).toBe(1);
    expect(result.metrics.assignment).toBe("treatment");
  });

  it("rejects invalid tool input and retains complete large results by handle", () => {
    const compiler = new MemoryResultCompiler(20, 1_024, 128);
    const result = compiler.compile(
      { rows: [{ id: 1, text: "a very long row" }] },
      { provenance: "fixture" },
    );
    expect(result.inline).toBe(false);
    expect(compiler.get(result.handle ?? "")).toEqual({
      rows: [{ id: 1, text: "a very long row" }],
    });
    expect(JSON.stringify(result.preview).length).toBeLessThanOrEqual(128);
    const packet = compileContext({
      task: "issue root cause",
      tokenBudget: 20,
      items: [
        { source: "private", text: "secret", authorized: false },
        { source: "a", text: "issue root cause found", confidence: 1 },
      ],
    });
    expect(packet.excluded).toContainEqual({ source: "private", reason: "permission" });
    expect(packet.facts[0]?.source).toBe("a");
  });

  it("validates draft 2020 schemas and fails runs that never reach a final response", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        kind: { enum: ["issue", "task"] },
        value: { type: "string", minLength: 2 },
      },
      required: ["kind", "value"],
      anyOf: [{ required: ["kind"] }, { required: ["value"] }],
      additionalProperties: false,
    };
    expect(validateToolInput({ kind: "issue", value: "ENG-142" }, schema)).toBeUndefined();
    expect(validateToolInput({ kind: "bug", value: "x" }, schema)).toContain("must be equal");
    const runtime = createRuntime({
      provider: createMockProvider(() => ({ toolCalls: [] })),
      tools: [],
    });
    await expect(runtime.run({ task: "stop", maxSteps: 0 })).rejects.toThrow(
      "Max steps reached before final model response",
    );
  });

  it("keeps the run deadline bounded when telemetry hangs", async () => {
    const started = Date.now();
    const runtime = createRuntime({
      provider: createMockProvider(() => ({ text: "done", toolCalls: [] })),
      telemetry: new Telemetry([{ export: () => new Promise<void>(() => undefined) }], {
        exporterTimeoutMs: 5_000,
      }),
      timeoutMs: 20,
    });

    await expect(runtime.run({ task: "deadline test" })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("applies runtime policy before discovery and inspection", async () => {
    const events = new MemoryTelemetryExporter();
    const denied: RuntimeTool = {
      ...tool(),
      id: "dangerous-write",
      name: "dangerous-write",
      metadata: { sideEffect: "write", idempotent: false },
    };
    const runtime = createRuntime({
      provider: createMockProvider((request) => {
        const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
        if (!lastTool)
          return {
            toolCalls: [{ id: "search", toolId: "search_tools", arguments: { query: "write" } }],
          };
        if (lastTool.name === "search_tools")
          return {
            toolCalls: [
              { id: "inspect", toolId: "inspect_tool", arguments: { toolId: denied.id } },
            ],
          };
        return { text: "policy applied", toolCalls: [] };
      }),
      tools: [tool(), denied],
      telemetry: new Telemetry([events]),
      policy: { denySideEffects: ["write"] },
      optimizations: { toolDiscovery: true },
    });
    await expect(runtime.run({ task: "find safe tools" })).resolves.toMatchObject({
      output: "policy applied",
    });
    const search = events.events.find((event) => event.type === "tool.search.completed");
    expect(JSON.stringify(search?.payload)).not.toContain(denied.id);
  });
});
