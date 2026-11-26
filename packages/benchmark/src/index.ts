export interface BenchmarkTask {
  id: string;
  task: string;
  requiredP95LatencyMs?: number;
  success(output: string): boolean;
}

export interface BenchmarkRun {
  output: string;
  latencyMs: number;
  /** Null means the provider did not return enough usage data to price the attempt. */
  costUsd: number | null;
  success: boolean;
  error?: string;
  timedOut?: boolean;
  metrics?: Record<string, unknown>;
}

export interface BenchmarkSummary {
  runs: BenchmarkRun[];
  successRate: number;
  /** P95 of successful attempts only; null means there were no successful attempts. */
  p95LatencyMs: number | null;
  /** P95 of every attempt, including failures and timeouts. */
  attemptP95LatencyMs: number;
  costPerSuccessfulTaskUsd: number | null;
  totalCostUsd: number | null;
  failureCount: number;
}

export interface BenchmarkResult {
  control: BenchmarkSummary;
  treatment: BenchmarkSummary;
  primaryMetric: "cost-per-successful-task-at-required-p95-latency";
  treatmentMeetsRequiredP95: boolean;
}

export type {
  BenchmarkChartBundle,
  BenchmarkChartOptions,
  ToolSchedulingChartOptions,
} from "./charts.js";
export { renderBenchmarkCharts, renderToolSchedulingChart } from "./charts.js";

export interface BenchmarkOptions {
  tasks: BenchmarkTask[];
  control: (task: BenchmarkTask) => Promise<BenchmarkRun>;
  treatment: (task: BenchmarkTask) => Promise<BenchmarkRun>;
  /** Run paired attempts sequentially by default to avoid provider-rate-limit contention. */
  concurrentPairs?: boolean;
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function summarize(runs: BenchmarkRun[]): BenchmarkSummary {
  const successes = runs.filter((run) => run.success).length;
  const costsKnown = runs.every((run) => run.costUsd !== null);
  const totalCostUsd = costsKnown ? runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) : null;
  const successfulLatencies = runs.filter((run) => run.success).map((run) => run.latencyMs);
  return {
    runs,
    successRate: runs.length ? successes / runs.length : 0,
    p95LatencyMs: successfulLatencies.length ? percentile(successfulLatencies, 0.95) : null,
    attemptP95LatencyMs: percentile(
      runs.map((run) => run.latencyMs),
      0.95,
    ),
    costPerSuccessfulTaskUsd: successes && totalCostUsd !== null ? totalCostUsd / successes : null,
    totalCostUsd,
    failureCount: runs.length - successes,
  };
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const controlRuns: BenchmarkRun[] = [];
  const treatmentRuns: BenchmarkRun[] = [];
  for (const [index, task] of options.tasks.entries()) {
    let control: BenchmarkRun;
    let treatment: BenchmarkRun;
    if (options.concurrentPairs) {
      [control, treatment] = await Promise.all([options.control(task), options.treatment(task)]);
    } else if (index % 2 === 0) {
      control = await options.control(task);
      treatment = await options.treatment(task);
    } else {
      treatment = await options.treatment(task);
      control = await options.control(task);
    }
    controlRuns.push({ ...control, success: control.success && task.success(control.output) });
    treatmentRuns.push({
      ...treatment,
      success: treatment.success && task.success(treatment.output),
    });
  }
  const control = summarize(controlRuns);
  const treatment = summarize(treatmentRuns);
  const requiredP95 = Math.max(...options.tasks.map((task) => task.requiredP95LatencyMs ?? 0), 0);
  return {
    control,
    treatment,
    primaryMetric: "cost-per-successful-task-at-required-p95-latency",
    treatmentMeetsRequiredP95:
      treatment.successRate === 1 &&
      treatment.p95LatencyMs !== null &&
      (requiredP95 === 0 || treatment.p95LatencyMs <= requiredP95),
  };
}
