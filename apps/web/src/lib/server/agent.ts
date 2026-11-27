import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntime, type Provider, type RuntimeMetrics, type RuntimeTool } from "@runto/core";
import type { ArmName, ArmResult, Levers, Span } from "@/lib/types";
import { factCheck, incidentSources, SYSTEM_PROMPT, TOOL_DELAY_MS } from "./scenario";
import { workersAiProvider } from "./workers-ai";

function tools(record: (span: Omit<Span, "start" | "end">, from: number) => void): RuntimeTool[] {
  return incidentSources.map((source) => ({
    id: source.id,
    name: source.name,
    description: source.description,
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string", minLength: 1 } },
      required: ["issueId"],
      additionalProperties: false,
    },
    metadata: { sideEffect: "read", idempotent: true },
    async execute(input) {
      const from = performance.now();
      await delay(TOOL_DELAY_MS);
      record({ kind: "tool", name: source.name }, from);
      return {
        source: source.name,
        issueId: (input as { issueId: string }).issueId,
        ...source.result,
        rawRecords: Array.from({ length: 80 }, (_, i) => ({
          id: `${source.name}-${i + 1}`,
          timestamp: `2026-08-04T14:${String(i % 20).padStart(2, "0")}:00Z`,
          message: `Raw ${source.name} observation ${i + 1}: correlated with ENG-142 and retained for provenance retrieval.`,
        })),
      };
    },
  }));
}

export async function runArm(
  arm: ArmName,
  task: string,
  levers: Levers,
  signal: AbortSignal,
): Promise<ArmResult> {
  const optimized = arm === "optimized";
  const spans: Span[] = [];
  const started = performance.now();
  const record = (span: Omit<Span, "start" | "end">, from: number) =>
    spans.push({
      ...span,
      start: Math.round(from - started),
      end: Math.round(performance.now() - started),
    });

  // The baseline keeps the model's default: reasoning on.
  const inner = workersAiProvider(optimized ? levers.thinking : true);
  let calls = 0;
  const provider: Provider = {
    name: inner.name,
    model: inner.model,
    costPerMillionTokens: inner.costPerMillionTokens,
    async generate(request) {
      const from = performance.now();
      const name = `model call ${++calls}`;
      try {
        return await inner.generate(request);
      } finally {
        record({ kind: "model", name }, from);
      }
    },
  };

  const runtime = createRuntime({
    provider,
    tools: tools(record),
    policy: {
      maxSteps: 5,
      maxToolCalls: incidentSources.length * 2,
      denySideEffects: ["write", "irreversible"],
    },
    optimizations: optimized
      ? {
          schemaCompiler: levers.schema,
          parallelExecution: levers.parallel
            ? {
                enabled: true,
                maxConcurrency: incidentSources.length,
                promptGuidance: true,
                // A tight cap suits short planning. With reasoning on it would cut the tool calls off.
                ...(levers.thinking ? {} : { planningOutputTokens: 768 }),
              }
            : false,
          resultCompiler: levers.compact
            ? { enabled: true, maxInlineBytes: 1_000, maxPreviewBytes: 768, conciseResponse: true }
            : false,
        }
      : { parallelExecution: false },
  });

  const toResult = (m: Partial<RuntimeMetrics>, output: string, error?: string): ArmResult => ({
    latencyMs: Math.round(performance.now() - started),
    modelMs: Math.round(m.modelDurationMs ?? 0),
    toolMs: Math.round(m.toolDurationMs ?? 0),
    inputTokens: m.inputTokens ?? 0,
    outputTokens: m.outputTokens ?? 0,
    costUsd: m.estimatedCostUsd ?? 0,
    modelCalls: m.modelCalls ?? 0,
    toolCalls: m.toolCalls ?? 0,
    // An answer that looked nothing up has no basis, however cheap and fast it was.
    success: !error && output.trim().length > 0 && (m.toolCalls ?? 0) > 0,
    facts: factCheck(output),
    ...(error ? { error } : {}),
    output,
    spans: [...spans].sort((a, b) => a.start - b.start),
  });

  try {
    const result = await runtime.run({
      task: `${SYSTEM_PROMPT}\n\nRequest: ${task}`,
      maxSteps: 5,
      signal,
      assignment: optimized ? "treatment" : "control",
    });
    return toResult(result.metrics, result.output);
  } catch (error) {
    const metrics = (error as { runtimeMetrics?: RuntimeMetrics }).runtimeMetrics ?? {};
    return toResult(metrics, "", error instanceof Error ? error.message : String(error));
  }
}
