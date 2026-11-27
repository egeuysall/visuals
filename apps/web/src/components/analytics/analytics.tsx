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
  ARM_LABEL,
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
          {ARM_LABEL[arm]}
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
    <section aria-label="results" className="flex min-h-0 min-w-0 flex-col lg:overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
        <Tabs value={source} onValueChange={(v) => setPicked(v as Source)}>
          <TabsList>
            <TabsTrigger value="yours">your results</TabsTrigger>
            <TabsTrigger value="recorded">earlier test</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">
          {source === "recorded"
            ? recordedLabel
            : mine.length
              ? `typical result over ${mine.length} ${mine.length === 1 ? "try" : "tries"}`
              : ""}
        </p>
      </div>

      {pairs.length === 0 ? (
        <div className="flex min-h-80 flex-1 flex-col items-start justify-center gap-3 p-5 text-xs">
          <p>{latest ? "no answer has finished both ways yet." : "no results yet."}</p>
          <p className="max-w-96 leading-5 text-muted-foreground">
            press compare to start. it takes about a minute.
          </p>
          <Button variant="outline" size="sm" onClick={() => setPicked("recorded")}>
            see the earlier test
          </Button>
        </div>
      ) : (
        <>
          <Hero pairs={pairs} />

          {shown && (
            <p className="border-b border-border px-4 py-3 text-xs leading-5 sm:px-5">
              latest answer check:{" "}
              {ARMS.map(
                (arm) =>
                  `${ARM_LABEL[arm]} found ${shown[arm].facts.found} of ${shown[arm].facts.total} key facts`,
              ).join(", ")}
              .{" "}
              <span className="text-muted-foreground">
                it only looks for key words, so read the answer too.
              </span>
            </p>
          )}

          {shown && (
            <>
              <Panel title="where the time went" hint="your latest try, from start to finish.">
                <PhaseChart run={shown} />
              </Panel>
              <Panel
                title="looking things up"
                hint="standard checks one source at a time. optimized checks them together."
                action={<Legend />}
              >
                <ToolChart run={shown} />
              </Panel>
            </>
          )}

          <Panel title="every try" hint="pick what to compare." action={<Legend />}>
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
            <RunsChart pairs={pairs} metric={metric} />
          </Panel>

          <div className="grid shrink-0 grid-cols-1 xl:grid-cols-2 xl:divide-x xl:divide-border">
            <Panel title="spend adds up" hint="estimated total across these tries.">
              <SpendChart pairs={pairs} />
              <Legend />
            </Panel>
            <Panel title="where the money goes" hint="estimated cost of a typical try.">
              <CostSplitChart pairs={pairs} pricing={pricing} />
            </Panel>
          </div>

          {shown && (
            <Panel title="history" hint="newest first. the top number is optimized.">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>question</TableHead>
                    {METRICS.map((m) => (
                      <TableHead key={m.key} className="text-right">
                        {m.label}
                      </TableHead>
                    ))}
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
                          <span className="block">{m.format(r.optimized[m.key])}</span>
                          <span className="block text-muted-foreground">
                            standard {m.format(r.baseline[m.key])}
                          </span>
                        </TableCell>
                      ))}
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
