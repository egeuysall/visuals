import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type BenchmarkResult, type BenchmarkRun, runBenchmark } from "@runto/benchmark";
import {
  createMockProvider,
  createRuntime,
  type RuntimeMetrics,
  type RuntimeTool,
} from "@runto/core";

type WorkloadKind = "independent" | "chain" | "write-barrier";

interface Workload {
  id: string;
  kind: WorkloadKind;
  toolCount: number;
  delayMs: number;
  maxConcurrency: number;
}

const tasksPerWorkload = positiveInt(process.env.NAVO_GENERAL_BENCHMARK_TASKS, 12, 100);
const delayMs = positiveInt(process.env.NAVO_GENERAL_TOOL_DELAY_MS, 30, 10_000);
const outputDirectory = resolve(
  process.cwd(),
  process.env.NAVO_GENERAL_BENCHMARK_OUTPUT ?? "../../artifacts/benchmarks/general",
);

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Operation aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function toolsFor(workload: Workload): RuntimeTool[] {
  return Array.from({ length: workload.toolCount }, (_, index) => ({
    id: `${workload.id}/tool-${index + 1}`,
    name: `${workload.id}_tool_${index + 1}`,
    description: `Synthetic ${workload.kind} I/O operation ${index + 1}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    metadata: {
      sideEffect:
        workload.kind === "write-barrier" && index === workload.toolCount - 1 ? "write" : "read",
      idempotent: true,
    },
    execute: async (_input, context) => {
      await wait(workload.delayMs, context.signal);
      return { tool: `${workload.id}/tool-${index + 1}`, ok: true };
    },
  }));
}

function providerFor(workload: Workload, tools: RuntimeTool[]) {
  return createMockProvider(
    (request) => {
      const completed = request.messages.filter((message) => message.role === "tool").length;
      if (workload.kind === "chain") {
        if (completed < workload.toolCount)
          return {
            toolCalls: [
              {
                id: `call-${completed + 1}`,
                toolId: tools[completed]?.id ?? tools[0]?.id ?? "",
                arguments: {},
              },
            ],
          };
      } else if (completed === 0) {
        return {
          toolCalls: tools.map((tool, index) => ({
            id: `call-${index + 1}`,
            toolId: tool.id,
            arguments: {},
          })),
        };
      }
      return { text: `${workload.id} completed`, toolCalls: [] };
    },
    { name: `general-${workload.id}`, model: "deterministic" },
  );
}

function runtimeFor(workload: Workload, parallelExecution: boolean) {
  const tools = toolsFor(workload);
  return createRuntime({
    provider: providerFor(workload, tools),
    tools,
    policy: { maxSteps: workload.toolCount + 2, maxToolCalls: workload.toolCount + 1 },
    optimizations: parallelExecution
      ? {
          parallelExecution: {
            enabled: true,
            maxConcurrency: workload.maxConcurrency,
            planningOutputTokens: 768,
          },
          resultCompiler: {
            enabled: true,
            maxInlineBytes: 1_000,
            maxPreviewBytes: 768,
            conciseResponse: true,
          },
        }
      : { parallelExecution: false },
  });
}

function isSuccessful(metrics: RuntimeMetrics | undefined, workload: Workload): boolean {
  return Boolean(
    metrics?.success &&
      metrics.invalidToolCalls === 0 &&
      metrics.executedTools.length === workload.toolCount,
  );
}

async function run(workload: Workload, parallelExecution: boolean): Promise<BenchmarkRun> {
  const started = Date.now();
  try {
    const result = await runtimeFor(workload, parallelExecution).run({
      task: `Use every ${workload.toolCount} ${workload.kind} tool and then summarize the result.`,
    });
    return {
      output: result.output,
      latencyMs: Date.now() - started,
      costUsd: result.metrics.estimatedCostUsd,
      success: isSuccessful(result.metrics, workload),
      metrics: result.metrics,
    };
  } catch (error) {
    const metrics =
      error instanceof Error
        ? (error as Error & { runtimeMetrics?: RuntimeMetrics }).runtimeMetrics
        : undefined;
    return {
      output: "",
      latencyMs: Date.now() - started,
      costUsd: metrics?.estimatedCostUsd ?? null,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metrics,
    };
  }
}

function speedup(result: BenchmarkResult): number | null {
  const control = result.control.p95LatencyMs;
  const treatment = result.treatment.p95LatencyMs;
  return control !== null && treatment !== null && treatment > 0
    ? Math.round((control / treatment) * 100) / 100
    : null;
}

const workloads: Workload[] = [
  { id: "independent-2", kind: "independent", toolCount: 2, delayMs, maxConcurrency: 2 },
  { id: "independent-8", kind: "independent", toolCount: 8, delayMs, maxConcurrency: 8 },
  { id: "independent-12", kind: "independent", toolCount: 12, delayMs, maxConcurrency: 12 },
  { id: "dependency-chain-6", kind: "chain", toolCount: 6, delayMs, maxConcurrency: 6 },
  { id: "write-barrier-8", kind: "write-barrier", toolCount: 8, delayMs, maxConcurrency: 8 },
];

const results = [];
for (const workload of workloads) {
  const result = await runBenchmark({
    tasks: Array.from({ length: tasksPerWorkload }, (_, index) => ({
      id: `${workload.id}-${index + 1}`,
      task: workload.id,
      success: (output: string) => output.length > 0,
    })),
    control: () => run(workload, false),
    treatment: () => run(workload, true),
  });
  results.push({
    workload,
    result,
    speedup: speedup(result),
    toolPhaseP95Ms: {
      control: toolPhaseP95(result.control.runs),
      treatment: toolPhaseP95(result.treatment.runs),
    },
  });
}

function toolPhaseP95(runs: BenchmarkRun[]): number | null {
  const values = runs
    .filter((run) => run.success)
    .map((run) => run.metrics?.toolDurationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  values.sort((left, right) => left - right);
  return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? null;
}

const report = {
  generatedAt: new Date().toISOString(),
  kind: "general-model-driven-workload-matrix",
  fixture: {
    provider: "deterministic mock",
    toolDelayMs: delayMs,
    tasksPerWorkload,
    note: "Synthetic I/O isolates scheduler behavior; it is not an external provider claim.",
  },
  results,
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "benchmark-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
