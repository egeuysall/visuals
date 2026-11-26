import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type BenchmarkRun,
  renderBenchmarkCharts,
  renderToolSchedulingChart,
  runBenchmark,
} from "@runto/benchmark";
import {
  createMockProvider,
  createRuntime,
  type RuntimeMetrics,
  type RuntimeTool,
} from "@runto/core";
import { createVercelProvider } from "@runto/provider-vercel";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gatewayApiKey = process.env.AI_GATEWAY_API_KEY;
const live = Boolean(gatewayApiKey && process.env.NAVO_BENCHMARK_LIVE !== "0");
const gatewayPricing = {
  input: Number(process.env.NAVO_BENCHMARK_INPUT_COST_PER_MILLION ?? 0),
  output: Number(process.env.NAVO_BENCHMARK_OUTPUT_COST_PER_MILLION ?? 0),
};

const positiveInt = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

interface IncidentSource {
  id: string;
  name: string;
  description: string;
  result: Record<string, unknown>;
}

const incidentSources: IncidentSource[] = [
  {
    id: "tracker/get-issue",
    name: "get_issue",
    description: "Read the issue title, symptoms, status, and first-seen timestamp.",
    result: {
      title: "Checkout intermittently rejects valid promo codes",
      status: "open",
      firstSeen: "2026-08-04T14:02:00Z",
      symptoms: ["promo validation returns 500", "error rate spikes after deploy"],
    },
  },
  {
    id: "tracker/get-comments",
    name: "get_comments",
    description: "Read customer and support comments attached to the issue.",
    result: {
      comments: [
        "Several customers report the failure only on carts with regional tax enabled.",
        "Support reproduced it after the afternoon checkout deployment.",
      ],
    },
  },
  {
    id: "git/list-related-commits",
    name: "list_related_commits",
    description: "Read commits and pull requests linked to the issue.",
    result: {
      changes: [
        { sha: "8f4c2a1", title: "Use normalized region in promo validation", mergedAt: "13:48Z" },
        { sha: "2bc91de", title: "Refactor tax and discount pipeline", mergedAt: "12:57Z" },
      ],
    },
  },
  {
    id: "git/get-code-ownership",
    name: "get_code_ownership",
    description: "Read the owning team and reviewers for checkout promotion code.",
    result: {
      team: "Checkout Platform",
      owner: "checkout-platform",
      reviewers: ["payments-oncall"],
    },
  },
  {
    id: "observability/search-logs",
    name: "search_logs",
    description: "Read production logs for the issue identifier and checkout error signature.",
    result: {
      error: "TypeError: cannot read properties of undefined (reading 'countryCode')",
      occurrences: 1842,
      window: "14:00-14:20Z",
      sampleService: "checkout-api",
    },
  },
  {
    id: "observability/get-deployment",
    name: "get_deployment",
    description: "Read the production deployment, release version, and rollout status.",
    result: {
      release: "checkout-api@2026.08.04.3",
      deployedAt: "2026-08-04T13:52:00Z",
      rollout: "100%",
      changedFiles: ["src/promo/normalize-region.ts", "src/tax/discount-context.ts"],
    },
  },
  {
    id: "observability/get-metrics",
    name: "get_metrics",
    description:
      "Read checkout error rate, latency, and regional breakdown for the incident window.",
    result: {
      baselineErrorRate: "0.18%",
      incidentErrorRate: "8.7%",
      p95LatencyMs: 1280,
      affectedRegions: ["EU", "UK"],
    },
  },
  {
    id: "config/get-feature-flags",
    name: "get_feature_flags",
    description: "Read feature flags affecting promo and tax normalization in production.",
    result: {
      flags: [
        { key: "promo-region-normalization", enabled: true, rollout: "100%" },
        { key: "regional-tax-v2", enabled: true, rollout: "100%" },
      ],
    },
  },
  {
    id: "docs/search-runbook",
    name: "search_runbook",
    description: "Read the incident runbook and approved mitigation for checkout failures.",
    result: {
      mitigation: "Disable promo-region-normalization or roll back checkout-api@2026.08.04.3.",
      verification: "Confirm promo validation 5xx rate returns below 0.5% for 10 minutes.",
    },
  },
  {
    id: "docs/search-design",
    name: "search_design_docs",
    description: "Read design documentation for the tax and promotion normalization contract.",
    result: {
      contract:
        "Tax context may omit countryCode for legacy carts; promo validation must preserve that case.",
      migrationNote:
        "The new normalizer assumes a region object exists when regional-tax-v2 is enabled.",
    },
  },
  {
    id: "git/list-recent-changes",
    name: "list_recent_changes",
    description: "Read recent production changes touching checkout, tax, and promotion code.",
    result: {
      changes: [
        "Promo normalization moved ahead of legacy-cart compatibility handling.",
        "Regional tax rollout changed from 10% canary to 100% immediately before the incident.",
      ],
    },
  },
  {
    id: "incidents/get-history",
    name: "get_incident_history",
    description: "Read prior incidents with similar checkout or regional-tax symptoms.",
    result: {
      incidents: [
        {
          id: "INC-77",
          lesson: "Legacy carts can omit region metadata; guard before normalization.",
        },
        {
          id: "INC-51",
          lesson: "Rollout flags should remain canary until regional metrics stabilize.",
        },
      ],
    },
  },
];

const incidentDelayMs = positiveInt(process.env.NAVO_INCIDENT_TOOL_DELAY_MS, 120, 10_000);
const incidentMaxConcurrency = Math.min(
  incidentSources.length,
  positiveInt(
    process.env.NAVO_INCIDENT_MAX_CONCURRENCY,
    incidentSources.length,
    incidentSources.length,
  ),
);
const taskCount = positiveInt(process.env.NAVO_BENCHMARK_TASKS, live ? 3 : 6, 100);
const treatmentReasoningEffort = process.env.NAVO_BENCHMARK_TREATMENT_REASONING_EFFORT ?? "low";
const incidentTask = `
You are the incident commander investigating production issue ENG-142.
Use every one of these read-only sources exactly once before writing the final report:
${incidentSources.map((source) => source.name).join(", ")}.
Call each with {"issueId":"ENG-142"}. These reads are independent, so request all of them together in one tool turn; do not wait for one independent source before requesting another.
After the tools return, write a concise report with exactly these sections: Root cause, Evidence, Recommendation.
Only use facts returned by tools. Identify the most likely root cause and the safest mitigation.
`.trim();

function incidentTool(source: IncidentSource): RuntimeTool {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string", minLength: 1 } },
      required: ["issueId"],
      additionalProperties: false,
    },
    metadata: {
      sideEffect: "read",
      idempotent: true,
      examples: [{ issueId: "ENG-142" }],
    },
    async execute(input) {
      await delay(incidentDelayMs);
      return {
        source: source.name,
        issueId: (input as { issueId: string }).issueId,
        ...source.result,
        rawRecords: Array.from({ length: 80 }, (_, index) => ({
          id: `${source.name}-${index + 1}`,
          timestamp: `2026-08-04T14:${String(index % 20).padStart(2, "0")}:00Z`,
          message: `Raw ${source.name} observation ${index + 1}: correlated with ENG-142 and retained for provenance retrieval.`,
        })),
      };
    },
  };
}

function incidentMockProvider() {
  return createMockProvider(
    (request) => {
      const hasToolResults = request.messages.some((message) => message.role === "tool");
      const inputTokens = Math.ceil(
        JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4,
      );
      return hasToolResults
        ? {
            text: "Root cause: the 100% regional-tax rollout exposed a legacy-cart null region to the new promo normalizer. Evidence: logs, deployment changes, feature flags, design docs, and incident history agree. Recommendation: disable promo-region-normalization or roll back the release, then verify the 5xx rate stays below the runbook threshold.",
            toolCalls: [],
            usage: { inputTokens, outputTokens: 600 },
          }
        : {
            toolCalls: incidentSources.map((source, index) => ({
              id: `incident-call-${index + 1}`,
              toolId: source.id,
              arguments: { issueId: "ENG-142" },
            })),
            usage: { inputTokens, outputTokens: 200 },
          };
    },
    { model: "mock-gpt-5", name: "deterministic-incident-provider" },
  );
}

function makeIncidentRuntime(parallelExecution: boolean) {
  const provider = live
    ? createVercelProvider({
        model: process.env.AI_GATEWAY_MODEL ?? "openai/gpt-5",
        apiKey: gatewayApiKey,
        gateway: true,
        costPerMillionTokens: gatewayPricing,
        providerOptions: { openai: { reasoningEffort: treatmentReasoningEffort } },
        maxOutputTokens: 2_000,
      })
    : {
        ...incidentMockProvider(),
        costPerMillionTokens: gatewayPricing,
      };
  return createRuntime({
    provider,
    tools: incidentSources.map(incidentTool),
    policy: { maxSteps: 5, maxToolCalls: incidentSources.length * 2 },
    optimizations: {
      parallelExecution: parallelExecution
        ? {
            enabled: true,
            maxConcurrency: incidentMaxConcurrency,
            promptGuidance: true,
            planningOutputTokens: 768,
          }
        : false,
      resultCompiler: parallelExecution
        ? { enabled: true, maxInlineBytes: 1_000, maxPreviewBytes: 768, conciseResponse: true }
        : false,
    },
  });
}

function successfulIncidentReport(output: string, metrics: RuntimeMetrics): boolean {
  const normalized = output.toLowerCase();
  return (
    metrics.success &&
    metrics.invalidToolCalls === 0 &&
    metrics.executedTools.length === incidentSources.length &&
    new Set(metrics.executedTools).size === incidentSources.length &&
    incidentSources.every((source) => metrics.executedTools.includes(source.id)) &&
    normalized.includes("root cause") &&
    normalized.includes("evidence") &&
    normalized.includes("recommendation")
  );
}

async function run(parallelExecution: boolean, task: string): Promise<BenchmarkRun> {
  const started = Date.now();
  const signal = live
    ? AbortSignal.timeout(Number(process.env.NAVO_RUN_TIMEOUT_MS ?? 120_000))
    : undefined;
  try {
    const result = await makeIncidentRuntime(parallelExecution).run({
      task,
      maxSteps: 5,
      ...(live ? { signal } : {}),
    });
    return {
      output: result.output,
      latencyMs: Date.now() - started,
      costUsd: result.metrics.estimatedCostUsd,
      success: successfulIncidentReport(result.output, result.metrics),
      metrics: result.metrics,
    };
  } catch (error) {
    const runtimeMetrics =
      error instanceof Error
        ? (error as Error & { runtimeMetrics?: RuntimeMetrics }).runtimeMetrics
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return {
      output: "",
      latencyMs: Date.now() - started,
      costUsd: runtimeMetrics?.estimatedCostUsd ?? null,
      success: false,
      error: message,
      timedOut: live && signal?.aborted === true,
      metrics: runtimeMetrics ? { ...runtimeMetrics, error: message } : { error: message },
    };
  }
}

function metricP95(runs: BenchmarkRun[], key: string): number | null {
  const values = runs
    .filter((run) => run.success)
    .map((run) => run.metrics?.[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

const benchmark = await runBenchmark({
  tasks: Array.from({ length: taskCount }, (_, index) => ({
    id: `incident-investigation-${index + 1}`,
    task: incidentTask,
    success: (output: string) => output.trim().length > 0,
  })),
  control: (task) => run(false, task.task),
  treatment: (task) => run(true, task.task),
});

const improvement = (control: number | null, treatment: number | null): number | null =>
  control === null || treatment === null || control === 0
    ? null
    : Math.round((1 - treatment / control) * 1000) / 10;

const speedup = (control: number | null, treatment: number | null): number | null =>
  control !== null && treatment !== null && treatment > 0
    ? Math.round((control / treatment) * 10) / 10
    : null;

const controlToolP95 = metricP95(benchmark.control.runs, "toolDurationMs");
const treatmentToolP95 = metricP95(benchmark.treatment.runs, "toolDurationMs");
const report = {
  generatedAt: new Date().toISOString(),
  live,
  model: live ? (process.env.AI_GATEWAY_MODEL ?? "openai/gpt-5") : "mock-gpt-5",
  scenario: {
    id: "production-incident-investigation",
    task: incidentTask,
    toolCount: incidentSources.length,
    toolDelayMs: incidentDelayMs,
    maxConcurrency: incidentMaxConcurrency,
    taskCount,
    treatmentOptimizations: [
      "parallelExecution",
      "resultCompiler",
      "planningOutputTokens:768",
      `reasoningEffort:${treatmentReasoningEffort}`,
    ],
  },
  pricing: {
    inputPerMillionTokens: gatewayPricing.input,
    outputPerMillionTokens: gatewayPricing.output,
    source: "NAVO_BENCHMARK_INPUT_COST_PER_MILLION and NAVO_BENCHMARK_OUTPUT_COST_PER_MILLION",
  },
  primaryMetric: benchmark.primaryMetric,
  control: benchmark.control,
  treatment: benchmark.treatment,
  improvement: {
    p95LatencyPercent: improvement(
      benchmark.control.p95LatencyMs,
      benchmark.treatment.p95LatencyMs,
    ),
    attemptP95LatencyPercent: improvement(
      benchmark.control.attemptP95LatencyMs,
      benchmark.treatment.attemptP95LatencyMs,
    ),
    costPerSuccessfulTaskPercent: improvement(
      benchmark.control.costPerSuccessfulTaskUsd,
      benchmark.treatment.costPerSuccessfulTaskUsd,
    ),
    successRateDelta: benchmark.treatment.successRate - benchmark.control.successRate,
  },
  treatmentMeetsRequiredP95: benchmark.treatmentMeetsRequiredP95,
  toolScheduling: {
    mode: "realistic-incident-tool-phase",
    metric: "runtime tool phase p95 latency",
    result: benchmark,
    improvement: {
      p95LatencyPercent: improvement(controlToolP95, treatmentToolP95),
      speedup: speedup(controlToolP95, treatmentToolP95),
      successRateDelta: benchmark.treatment.successRate - benchmark.control.successRate,
      controlToolP95Ms: controlToolP95,
      treatmentToolP95Ms: treatmentToolP95,
    },
  },
};

const outputDirectory = resolve(
  process.cwd(),
  process.env.NAVO_BENCHMARK_OUTPUT ?? "../../artifacts/benchmarks/latest",
);
const charts = renderBenchmarkCharts(report, {
  provider: live ? "Vercel AI Gateway" : "deterministic mock",
  model: report.model,
  live,
  description:
    "Control: serial model-selected reads • Treatment: validated fan-out + compact results",
});
const toolSchedulingChart = renderToolSchedulingChart(benchmark, {
  toolCount: incidentSources.length,
  toolDelayMs: incidentDelayMs,
  maxConcurrency: incidentMaxConcurrency,
  taskCount,
});
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "benchmark-results.json"), JSON.stringify(report, null, 2)),
  writeFile(join(outputDirectory, "latency-by-task.svg"), charts.latency),
  writeFile(join(outputDirectory, "benchmark-summary.svg"), charts.summary),
  writeFile(join(outputDirectory, "cost-success-frontier.svg"), charts.frontier),
  writeFile(join(outputDirectory, "tool-scheduling.svg"), toolSchedulingChart),
]);

console.log(
  JSON.stringify(
    {
      ...report,
      artifacts: {
        directory: outputDirectory,
        files: [
          "benchmark-results.json",
          "latency-by-task.svg",
          "benchmark-summary.svg",
          "cost-success-frontier.svg",
          "tool-scheduling.svg",
        ],
      },
    },
    null,
    2,
  ),
);
