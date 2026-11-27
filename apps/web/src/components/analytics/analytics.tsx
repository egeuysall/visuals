"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Run } from "@/lib/types";
import { CostSplitChart, PhaseChart, RunsChart, SpendChart, ToolChart } from "./charts";
import {
  ARMS,
  METRICS,
  type MetricKey,
  type Pair,
  recordedLabel,
  recordedPairs,
  recordedPricing,
  successful,
} from "./data";
import { Hero } from "./hero";

type Source = "yours" | "recorded";

function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 border-b border-border px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Legend() {
  return (
    <ul className="flex gap-4 text-xs text-muted-foreground">
      {ARMS.map((arm) => (
        <li key={arm} className="flex items-center gap-1.5">
          <span
            className={`size-2 rounded-[2px] ${arm === "optimized" ? "bg-arm-optimized" : "bg-arm-baseline"}`}
          />
          {arm}
        </li>
      ))}
    </ul>
  );
}

export function Analytics({ runs }: { runs: Run[] }) {
  const latest = runs.at(-1);
  const [picked, setPicked] = useState<Source | null>(null);
  const [metric, setMetric] = useState<MetricKey>("latencyMs");
  const [seen, setSeen] = useState(latest?.id);

  // A new run brings the panel back to your own data.
  if (latest?.id !== seen) {
    setSeen(latest?.id);
    setPicked(null);
  }

  const source: Source = picked ?? (latest ? "yours" : "recorded");
  // Different models are never mixed in one summary: only runs of the latest run's model count.
  const mine = runs.filter((r) => successful(r) && r.model === latest?.model);
  const pairs: Pair[] = source === "recorded" ? recordedPairs : mine;
  const pricing =
    source === "recorded" ? recordedPricing : (mine.at(-1)?.pricing ?? recordedPricing);
  const shown = source === "yours" ? mine.at(-1) : undefined;

  return (
    <section aria-label="analytics" className="flex min-h-0 min-w-0 flex-col lg:overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
        <Tabs value={source} onValueChange={(v) => setPicked(v as Source)}>
          <TabsList>
            <TabsTrigger value="yours">your runs</TabsTrigger>
            <TabsTrigger value="recorded">recorded benchmark</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">
          {source === "recorded"
            ? recordedLabel
            : mine.length
              ? `${latest?.model}, median of ${mine.length}`
              : ""}
        </p>
      </div>

      {pairs.length === 0 ? (
        <div className="flex min-h-80 flex-1 flex-col items-start justify-center gap-3 p-5 text-xs">
          <p>{latest ? "no run has succeeded in both arms yet." : "no runs yet."}</p>
          <p className="max-w-96 leading-5 text-muted-foreground">
            type run in the terminal. a run takes about a minute: the baseline keeps reasoning on.
          </p>
          <Button variant="outline" size="sm" onClick={() => setPicked("recorded")}>
            show the recorded benchmark
          </Button>
        </div>
      ) : (
        <>
          <Hero pairs={pairs} />

          {shown && (
            <p className="border-b border-border px-4 py-3 text-xs leading-5 sm:px-5">
              <span className="text-muted-foreground">key facts in the latest answers: </span>
              {ARMS.map((arm) => `${arm} ${shown[arm].facts.found}/${shown[arm].facts.total}`).join(
                ", ",
              )}
              <span className="text-muted-foreground">
                . a keyword check. read the answer before you trust a saving.
              </span>
            </p>
          )}

          {shown && (
            <>
              <Panel
                title="where the time went"
                hint="your latest run, end to end, on one time scale."
              >
                <PhaseChart run={shown} />
              </Panel>
              <Panel
                title="tool calls"
                hint="timed from each arm's first call. one after another, or all at once."
                action={<Legend />}
              >
                <ToolChart run={shown} />
              </Panel>
            </>
          )}

          <Panel
            title="run by run"
            hint="both arms for every run, measured from zero."
            action={<Legend />}
          >
            <div className="flex flex-wrap gap-1" role="group" aria-label="metric">
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
            <RunsChart pairs={pairs} metric={metric} />
          </Panel>

          <div className="grid shrink-0 grid-cols-1 xl:grid-cols-2 xl:divide-x xl:divide-border">
            <Panel title="spend adds up" hint="estimated cost, summed over these runs.">
              <SpendChart pairs={pairs} />
              <Legend />
            </Panel>
            <Panel title="where the money goes" hint="median task, estimated from tokens.">
              <CostSplitChart pairs={pairs} pricing={pricing} />
            </Panel>
          </div>

          {shown && (
            <Panel title="your runs" hint="newest first. baseline → optimized.">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>task</TableHead>
                    {METRICS.map((m) => (
                      <TableHead key={m.key} className="text-right">
                        {m.label}
                      </TableHead>
                    ))}
                    <TableHead>optimizations</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...mine].reverse().map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-48 truncate normal-case" title={r.task}>
                        {r.task}
                      </TableCell>
                      {METRICS.map((m) => (
                        <TableCell
                          key={m.key}
                          className="text-right whitespace-nowrap tabular-nums"
                        >
                          {m.format(r.baseline[m.key])} → {m.format(r.optimized[m.key])}
                        </TableCell>
                      ))}
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {[
                          r.levers.parallel && "parallel",
                          r.levers.compact && "compact",
                          r.levers.schema && "schema",
                          !r.levers.thinking && "no thinking",
                        ]
                          .filter(Boolean)
                          .join(", ") || "none"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          )}
        </>
      )}
    </section>
  );
}
