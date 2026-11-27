import recorded from "@/data/recorded-benchmark.json";
import type { ArmName, Run } from "@/lib/types";

export const ARMS: ArmName[] = ["baseline", "optimized"];
export const ARM_LABEL: Record<ArmName, string> = {
  baseline: "standard",
  optimized: "optimized",
};

export interface Point {
  latencyMs: number;
  modelMs: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A baseline and an optimized measurement of the same task. */
export type Pair = Record<ArmName, Point>;

export type MetricKey = "costUsd" | "latencyMs" | "toolMs" | "inputTokens" | "outputTokens";

export const seconds = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s` : `${Math.round(ms)}ms`;
export const dollars = (n: number) =>
  `$${n === 0 ? "0" : n.toFixed(n < 0.001 ? 6 : n < 0.01 ? 5 : 3)}`;
export const count = (n: number) => Math.round(n).toLocaleString("en-US");
export const compact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`;

export const METRICS: {
  key: MetricKey;
  label: string;
  better: string;
  worse: string;
  format: (n: number) => string;
}[] = [
  { key: "costUsd", label: "cost", better: "cheaper", worse: "pricier", format: dollars },
  { key: "latencyMs", label: "total time", better: "faster", worse: "slower", format: seconds },
  { key: "toolMs", label: "looking things up", better: "faster", worse: "slower", format: seconds },
  { key: "inputTokens", label: "text read", better: "less", worse: "more", format: count },
  { key: "outputTokens", label: "text written", better: "less", worse: "more", format: count },
];

export const recordedPairs: Pair[] = recorded.control.flatMap((c, i) => {
  const t = recorded.treatment[i];
  if (!t || !c.success || !t.success) return [];
  const point = (r: typeof c): Point => ({
    ...r,
    modelMs: r.modelDurationMs,
    toolMs: r.toolDurationMs,
  });
  return [{ baseline: point(c), optimized: point(t) }];
});

export const recordedPricing = recorded.pricing;
export const recordedLabel = `${recordedPairs.length} tries each way`;

export const successful = (r: Run) => r.baseline.success && r.optimized.success;
