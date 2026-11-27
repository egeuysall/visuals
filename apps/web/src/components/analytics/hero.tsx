import { median, ratio } from "@/lib/stats";
import { ARMS, METRICS, type MetricKey, type Pair } from "./data";

const HERO: MetricKey[] = ["costUsd", "latencyMs", "toolMs", "inputTokens"];

/** The four headline gains, each with both medians drawn to the same scale. */
export function Hero({ pairs }: { pairs: Pair[] }) {
  return (
    <dl className="grid grid-cols-1 gap-px border-b border-border bg-border sm:grid-cols-2">
      {HERO.map((key) => {
        const metric = METRICS.find((m) => m.key === key)!;
        const values = {
          baseline: median(pairs.map((p) => p.baseline[key])),
          optimized: median(pairs.map((p) => p.optimized[key])),
        };
        const r = ratio(values.baseline, values.optimized);
        const max = Math.max(values.baseline, values.optimized) || 1;
        const better = r !== null && r >= 1;
        return (
          <div key={key} className="bg-background px-4 py-4 sm:px-5">
            <dt className="text-xs text-muted-foreground">{metric.label}</dt>
            <dd>
              <p className="mt-1 flex items-baseline gap-2">
                <span className="text-4xl leading-none font-semibold tracking-tight">
                  {r === null ? "n/a" : `${(better ? r : 1 / r).toFixed(1)}x`}
                </span>
                <span className="text-xs">
                  {r === null ? "" : better ? metric.better : metric.worse}
                </span>
              </p>
              <div className="mt-3 space-y-1.5">
                {ARMS.map((arm) => (
                  <div
                    key={arm}
                    className="grid grid-cols-[4.75rem_1fr_4.5rem] items-center gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">{arm}</span>
                    <span className="h-2">
                      <span
                        className={`block h-full min-w-0.5 rounded-r-sm transition-[width] duration-500 motion-reduce:transition-none ${arm === "optimized" ? "bg-arm-optimized" : "bg-arm-baseline"}`}
                        style={{ width: `${(values[arm] / max) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums">{metric.format(values[arm])}</span>
                  </div>
                ))}
              </div>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
