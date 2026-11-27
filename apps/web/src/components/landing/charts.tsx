"use client";

import { useState } from "react";
import {
  CostSplitChart,
  PhaseChart,
  RunsChart,
  SpendChart,
  ToolChart,
} from "@/components/analytics/charts";
import { METRICS, type MetricKey, recentPairs, recentPricing } from "@/components/analytics/data";
import { Hero } from "@/components/analytics/hero";
import { ArmLegend, Panel } from "@/components/analytics/panel";
import { Button } from "@/components/ui/button";
import sample from "@/data/sample-run.json";
import type { ArmName, Span } from "@/lib/types";

const sampleRun = {
  baseline: { spans: sample.baseline.spans as Span[] },
  optimized: { spans: sample.optimized.spans as Span[] },
} satisfies Record<ArmName, { spans: Span[] }>;

export function Headline() {
  return (
    <div className="border-x border-t border-border">
      <Hero pairs={recentPairs} />
    </div>
  );
}

export function OneQuestion() {
  return (
    <div className="border-x border-t border-border">
      <Panel title="where the time went" hint="one typical question, from start to finish.">
        <PhaseChart run={sampleRun} />
      </Panel>
      <Panel
        title="looking things up"
        hint="standard checks one source at a time. optimized checks all twelve together."
        action={<ArmLegend />}
      >
        <ToolChart run={sampleRun} />
      </Panel>
    </div>
  );
}

export function EveryTest() {
  const [metric, setMetric] = useState<MetricKey>("latencyMs");
  return (
    <div className="border-x border-t border-border">
      <Panel
        title="every try"
        hint="including the ones where it did less well."
        action={<ArmLegend />}
      >
        <div className="flex flex-wrap gap-1" role="group" aria-label="what to compare">
          {METRICS.map((m) => (
            <Button
              key={m.key}
              size="sm"
              variant={metric === m.key ? "secondary" : "ghost"}
              aria-pressed={metric === m.key}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </Button>
          ))}
        </div>
        <RunsChart pairs={recentPairs} metric={metric} />
      </Panel>
      <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-border">
        <Panel title="spend adds up" hint="estimated total across these tries.">
          <SpendChart pairs={recentPairs} />
          <ArmLegend />
        </Panel>
        <Panel title="where the money goes" hint="estimated cost of a typical try.">
          <CostSplitChart pairs={recentPairs} pricing={recentPricing} />
        </Panel>
      </div>
    </div>
  );
}
