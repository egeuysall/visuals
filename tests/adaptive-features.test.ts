import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCacheAdapter, SqliteCacheAdapter } from "@runto/cache";
import {
  createMockProvider,
  createRecordingProvider,
  createReplayProvider,
  createReplayTrace,
  createRuntime,
  createToolRegistry,
  InMemoryWorkflowMemory,
  type ProviderRequest,
  type RuntimeTool,
} from "@runto/core";
import { createRuntimeEvent } from "@runto/protocol";
import { ConvexTelemetryExporter, MemoryTelemetryExporter, Telemetry } from "@runto/telemetry";
import { describe, expect, it } from "vitest";

function fixtureTool(
  id: string,
  execute: RuntimeTool["execute"],
  inputSchema: RuntimeTool["inputSchema"] = {
    type: "object",
    properties: { value: { type: "string" } },
    additionalProperties: false,
  },
): RuntimeTool {
  return {
    id,
    name: id,
    description: `Fixture ${id}`,
    inputSchema,
    metadata: { sideEffect: "read", idempotent: true },
    execute,
  };
}

describe("production runtime seams", () => {
  it("persists cache entries in SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aar-cache-"));
    const cache = new SqliteCacheAdapter(join(directory, "cache.sqlite"));
    await cache.set("key", { value: { ok: true }, createdAt: 1 });
    await expect(cache.get("key")).resolves.toMatchObject({ value: { ok: true } });
    await cache.clear();
    await expect(cache.get("key")).resolves.toBeUndefined();
    cache.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("prunes expired and high-cardinality file cache entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "navo-file-cache-"));
    const cache = new FileCacheAdapter(directory, 2);
    await cache.set("expired", { value: 0, createdAt: 1, expiresAt: Date.now() - 1 });
    await expect(cache.get("expired")).resolves.toBeUndefined();
    await cache.set("a", { value: 1, createdAt: 1 });
    await cache.set("b", { value: 2, createdAt: 2 });
    await cache.set("c", { value: 3, createdAt: 3 });
    await expect(cache.get("a")).resolves.toBeUndefined();
    await expect(cache.get("c")).resolves.toMatchObject({ value: 3 });
    await rm(directory, { recursive: true, force: true });
  });

  it("validates live-cache values before reuse", async () => {
    let executions = 0;
    let validations = 0;
    const lookup = fixtureTool("lookup", async () => {
      executions += 1;
      return { value: "fresh" };
    });
    lookup.metadata.cachePolicy = { mode: "validate-before-use" };
    lookup.metadata.cacheValidator = async (value) => {
      validations += 1;
      return value === undefined || (value as { value?: string }).value === "fresh";
    };
    const provider = createMockProvider((request: ProviderRequest) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "done", toolCalls: [] }
        : { toolCalls: [{ id: "call", toolId: "lookup", arguments: { value: "x" } }] },
    );
    const runtime = createRuntime({
      provider,
      tools: [lookup],
      optimizations: { cache: true },
    });
    await runtime.run({ task: "lookup" });
    const second = await runtime.run({ task: "lookup" });
    expect(executions).toBe(1);
    expect(validations).toBe(1);
    expect(second.metrics.cacheHits).toBe(1);
    expect(second.metrics.cacheValidationCalls).toBe(1);
  });

  it("infers dependencies and hydrates $call references", async () => {
    let dependentInput: unknown;
    const first = fixtureTool("first", async () => ({ id: "record-1" }));
    const second = fixtureTool("second", async (input) => {
      dependentInput = input;
      return { ok: true };
    });
    const provider = createMockProvider((request: ProviderRequest) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "done", toolCalls: [] }
        : {
            toolCalls: [
              { id: "first-call", toolId: "first", arguments: { value: "x" } },
              { id: "second-call", toolId: "second", arguments: { value: "$call:first-call.id" } },
            ],
          },
    );
    const runtime = createRuntime({
      provider,
      tools: [first, second],
      optimizations: { parallelExecution: { enabled: true, maxConcurrency: 2 } },
    });
    const result = await runtime.run({ task: "dependent read" });
    expect(result.metrics.inferredDependencyCount).toBe(1);
    expect(dependentInput).toEqual({ value: "record-1" });
  });

  it("records and replays provider exchanges", async () => {
    const base = createMockProvider(() => ({ text: "ok", toolCalls: [] }));
    const trace = createReplayTrace(base);
    const recorded = createRecordingProvider(base, trace);
    const request = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };
    const expected = await recorded.generate(request);
    expect(expected.text).toBe("ok");
    expect(trace.exchanges).toHaveLength(1);
    await expect(createReplayProvider(trace).generate(request)).resolves.toEqual(expected);
  });

  it("reuses exact read-only speculative results", async () => {
    let executions = 0;
    const lookup = fixtureTool("lookup", async () => {
      executions += 1;
      return { value: "speculated" };
    });
    const provider = createMockProvider((request: ProviderRequest) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "done", toolCalls: [] }
        : { toolCalls: [{ id: "lookup-call", toolId: "lookup", arguments: { value: "x" } }] },
    );
    const runtime = createRuntime({
      provider,
      tools: [lookup],
      optimizations: { speculation: { enabled: true, maxCostUsd: 0 } },
    });
    const result = await runtime.run({
      task: "lookup",
      speculationTrace: [
        { toolId: "lookup", arguments: { value: "x" }, sideEffect: "read", confidence: 1 },
      ],
    });
    expect(executions).toBe(1);
    expect(result.output).toBe("done");
  });

  it("learns successful workflow tool sequences", async () => {
    const memory = new InMemoryWorkflowMemory();
    await memory.record("investigate incident", ["logs", "deployments"]);
    expect(await memory.suggest("investigate production incident")).toEqual([
      "logs",
      "deployments",
    ]);
  });

  it("uses injected embedding and learned discovery strategies", async () => {
    const tools = createToolRegistry(
      [
        fixtureTool("logs", async () => ({ ok: true })),
        fixtureTool("deployments", async () => ({ ok: true })),
      ],
      {
        embeddingProvider: { embed: async (text) => (text.includes("logs") ? [1, 0] : [0, 1]) },
        learnedToolRanker: {
          rank: async () => [
            { toolId: "deployments", score: 2 },
            { toolId: "logs", score: 1 },
          ],
        },
      },
    );
    await expect(
      tools.searchAsync("logs", { strategy: "embedding", topK: 1 }),
    ).resolves.toMatchObject([{ id: "logs" }]);
    await expect(
      tools.searchAsync("anything", { strategy: "learned", topK: 1 }),
    ).resolves.toMatchObject([{ id: "deployments" }]);
  });

  it("batches hosted telemetry with an explicit ingest key", async () => {
    let request: RequestInit | undefined;
    const exporter = new ConvexTelemetryExporter({
      url: "https://convex.example",
      apiKey: "secret",
      fetch: async (_url, init) => {
        request = init;
        return new Response(null, { status: 202 });
      },
    });
    await exporter.export(createRuntimeEvent("run.started", { payload: { task: "test" } }));
    await exporter.flush();
    expect(request?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(request?.body))).toHaveLength(1);
  });

  it("redacts telemetry content by default", async () => {
    const exporter = new MemoryTelemetryExporter();
    await new Telemetry([exporter]).emit("run.started", {
      payload: { task: "private customer context" },
    });
    expect(JSON.stringify(exporter.events[0]?.payload)).not.toContain("private customer context");
  });

  it("surfaces exporter failures without wedging later flushes", async () => {
    const errors: unknown[] = [];
    const exporter = {
      export: async () => {
        throw new Error("sink unavailable");
      },
    };
    const telemetry = new Telemetry([exporter], {
      onExporterError: (error) => {
        errors.push(error);
      },
    });
    await telemetry.emit("run.started");
    expect(telemetry.getLastExporterError()).toBeInstanceOf(Error);
    expect(errors).toHaveLength(1);
    await expect(
      new Telemetry([exporter], { failOnExporterError: true }).emit("run.started"),
    ).rejects.toThrow("sink unavailable");
  });

  it("bounds a hung telemetry exporter", async () => {
    const telemetry = new Telemetry([{ export: () => new Promise<void>(() => undefined) }], {
      exporterTimeoutMs: 10,
    });
    await telemetry.emit("run.started");
    expect(telemetry.getLastExporterError()).toBeInstanceOf(Error);
    expect(String(telemetry.getLastExporterError())).toContain("timed out");
  });
});
