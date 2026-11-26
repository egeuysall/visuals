import {
  type BenchmarkResult,
  renderBenchmarkCharts,
  renderToolSchedulingChart,
  runBenchmark,
} from "@runto/benchmark";
import { describe, expect, it } from "vitest";

const result: BenchmarkResult = {
  primaryMetric: "cost-per-successful-task-at-required-p95-latency",
  treatmentMeetsRequiredP95: true,
  control: {
    runs: [
      { output: "ok", latencyMs: 120, costUsd: 0.02, success: true },
      { output: "ok", latencyMs: 100, costUsd: 0.02, success: true },
      { output: "ok", latencyMs: 140, costUsd: 0.02, success: true },
    ],
    successRate: 1,
    p95LatencyMs: 140,
    attemptP95LatencyMs: 140,
    costPerSuccessfulTaskUsd: 0.02,
    totalCostUsd: 0.06,
    failureCount: 0,
  },
  treatment: {
    runs: [
      { output: "ok", latencyMs: 80, costUsd: 0.01, success: true },
      { output: "ok", latencyMs: 70, costUsd: 0.01, success: true },
      { output: "ok", latencyMs: 90, costUsd: 0.01, success: true },
    ],
    successRate: 1,
    p95LatencyMs: 90,
    attemptP95LatencyMs: 90,
    costPerSuccessfulTaskUsd: 0.01,
    totalCostUsd: 0.03,
    failureCount: 0,
  },
};

describe("benchmark charts", () => {
  it("renders measured control and treatment charts without invalid SVG values", () => {
    const charts = renderBenchmarkCharts(result, {
      provider: "test provider",
      model: "test model",
      live: true,
    });

    for (const chart of Object.values(charts)) {
      expect(chart.startsWith("<svg ")).toBe(true);
      expect(chart).toContain("Control");
      expect(chart).toContain("Treatment");
      expect(chart).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect(charts.frontier).toContain("logarithmic cost axis");
    expect(charts.latency).toContain("End-to-end latency (ms)");
  });

  it("does not draw a cost claim when token pricing is unavailable", () => {
    const noPricing: BenchmarkResult = {
      ...result,
      control: { ...result.control, costPerSuccessfulTaskUsd: 0, totalCostUsd: 0 },
      treatment: { ...result.treatment, costPerSuccessfulTaskUsd: 0, totalCostUsd: 0 },
    };
    const charts = renderBenchmarkCharts(noPricing);

    expect(charts.frontier).toContain("Cost chart unavailable");
    expect(charts.frontier).toContain("No cost claim is rendered");
  });

  it("keeps failed attempts out of successful p95 and marks them in charts", async () => {
    const benchmark = await runBenchmark({
      tasks: [
        { id: "ok", task: "ok", success: (output) => output === "ok" },
        { id: "timeout", task: "timeout", success: (output) => output === "ok" },
      ],
      control: async () => ({ output: "ok", latencyMs: 80, costUsd: 0.02, success: true }),
      treatment: async (task) =>
        task.id === "ok"
          ? { output: "ok", latencyMs: 20, costUsd: 0.01, success: true }
          : {
              output: "",
              latencyMs: 60_000,
              costUsd: null,
              success: false,
              error: "Delay was aborted",
              timedOut: true,
            },
    });

    expect(benchmark.treatment.p95LatencyMs).toBe(20);
    expect(benchmark.treatment.attemptP95LatencyMs).toBe(60_000);
    expect(benchmark.treatment.successRate).toBe(0.5);
    expect(benchmark.treatment.costPerSuccessfulTaskUsd).toBeNull();
    expect(benchmark.treatmentMeetsRequiredP95).toBe(false);

    const charts = renderBenchmarkCharts(benchmark);
    expect(charts.latency).toContain("TIMEOUT");
    expect(charts.frontier).toContain("Cost per successful task is unavailable");
    expect(charts.latency).not.toContain("-623.6%");
  });

  it("renders the isolated tool scheduling speedup separately", () => {
    const toolResult: BenchmarkResult = {
      ...result,
      control: {
        ...result.control,
        p95LatencyMs: 1_000,
        attemptP95LatencyMs: 1_000,
        runs: result.control.runs.map((run) => ({ ...run, metrics: { toolDurationMs: 1_000 } })),
      },
      treatment: {
        ...result.treatment,
        p95LatencyMs: 100,
        attemptP95LatencyMs: 100,
        runs: result.treatment.runs.map((run) => ({ ...run, metrics: { toolDurationMs: 100 } })),
      },
    };
    const chart = renderToolSchedulingChart(toolResult, {
      toolCount: 10,
      toolDelayMs: 100,
      maxConcurrency: 10,
      taskCount: 3,
    });

    expect(chart).toContain("Parallel tool scheduling");
    expect(chart).toContain("same end-to-end incident benchmark");
    expect(chart).toContain("10.0×");
    expect(chart).toContain("excludes Gateway/model latency");
  });
});
