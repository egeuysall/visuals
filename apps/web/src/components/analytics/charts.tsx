"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { median } from "@/lib/stats";
import type { ArmName, Span } from "@/lib/types";
import {
  ARM_LABEL,
  ARMS,
  compact,
  dollars,
  METRICS,
  type MetricKey,
  type Pair,
  seconds,
} from "./data";

/** The part of a result the timelines draw. */
type Timeline = Record<ArmName, { spans: Span[] }>;

const arms: ChartConfig = {
  baseline: { label: "standard", color: "var(--arm-baseline)" },
  optimized: { label: "optimized", color: "var(--arm-optimized)" },
};
const fill = (arm: ArmName) => `var(--arm-${arm})`;

/** One tooltip line: a swatch, a name and a formatted value. */
function row(name: string, value: string, color: string) {
  return (
    <span className="flex w-full items-center gap-2">
      <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
      <span className="text-muted-foreground">{name}</span>
      <span className="ml-auto pl-3 tabular-nums">{value}</span>
    </span>
  );
}

const PHASES = [
  { key: "plan", label: "planning", opacity: 0.55 },
  { key: "tools", label: "looking things up", opacity: 1 },
  { key: "answer", label: "writing the answer", opacity: 0.3 },
] as const;

function phases(spans: Span[]) {
  const tools = spans.filter((s) => s.kind === "tool");
  const first = tools.length ? Math.min(...tools.map((s) => s.start)) : 0;
  const last = tools.length ? Math.max(...tools.map((s) => s.end)) : 0;
  const end = Math.max(0, ...spans.map((s) => s.end));
  return tools.length
    ? { plan: first, tools: last - first, answer: end - last }
    : { plan: end, tools: 0, answer: 0 };
}

/** End to end time of one run, split into planning, tools and the answer. */
export function PhaseChart({ run }: { run: Timeline }) {
  const data = ARMS.map((arm) => ({ arm, ...phases(run[arm].spans) }));
  return (
    <>
      <ChartContainer config={arms} className="aspect-auto h-32 w-full">
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickFormatter={seconds} tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="arm"
            width={72}
            tickLine={false}
            axisLine={false}
            tickFormatter={(arm: ArmName) => ARM_LABEL[arm]}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                formatter={(value, name, item) =>
                  row(
                    PHASES.find((p) => p.key === name)?.label ?? String(name),
                    seconds(Number(value)),
                    fill(item.payload.arm),
                  )
                }
              />
            }
          />
          {PHASES.map((phase) => (
            <Bar
              key={phase.key}
              dataKey={phase.key}
              stackId="time"
              stroke="var(--background)"
              strokeWidth={2}
            >
              {data.map((d) => (
                <Cell key={d.arm} fill={fill(d.arm)} fillOpacity={phase.opacity} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {PHASES.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-foreground" style={{ opacity: p.opacity }} />
            {p.label}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Each tool call, timed from the arm's first tool call: serial makes a staircase. */
export function ToolChart({ run }: { run: Timeline }) {
  const times = Object.fromEntries(
    ARMS.map((arm) => {
      const tools = run[arm].spans.filter((s) => s.kind === "tool");
      const zero = Math.min(...tools.map((s) => s.start));
      return [arm, new Map(tools.map((s) => [s.name, [s.start - zero, s.end - zero]]))];
    }),
  ) as Record<ArmName, Map<string, number[]>>;
  const names = [...new Set(ARMS.flatMap((arm) => [...times[arm].keys()]))];
  if (!names.length) return <p className="text-xs text-muted-foreground">nothing was looked up.</p>;
  const data = names.map((name) => ({
    name: name.replaceAll("_", " "),
    baseline: times.baseline.get(name),
    optimized: times.optimized.get(name),
  }));
  return (
    <ChartContainer
      config={arms}
      className="aspect-auto w-full"
      style={{ height: names.length * 26 + 32 }}
    >
      <BarChart
        data={data}
        layout="vertical"
        margin={{ left: 0, right: 8 }}
        barGap={2}
        barCategoryGap={4}
      >
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickFormatter={seconds} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={168}
          tickLine={false}
          axisLine={false}
          interval={0}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => {
                const [from, to] = value as unknown as [number, number];
                return row(
                  ARM_LABEL[name as ArmName],
                  `${seconds(from)} to ${seconds(to)}`,
                  fill(name as ArmName),
                );
              }}
            />
          }
        />
        {ARMS.map((arm) => (
          <Bar key={arm} dataKey={arm} fill={`var(--color-${arm})`} radius={2} minPointSize={3} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** Both arms for every run, one metric at a time, from zero. */
export function RunsChart({ pairs, metric }: { pairs: Pair[]; metric: MetricKey }) {
  const format = METRICS.find((m) => m.key === metric)!.format;
  const data = pairs.map((p, i) => ({
    run: `${i + 1}`,
    baseline: p.baseline[metric],
    optimized: p.optimized[metric],
  }));
  return (
    <ChartContainer config={arms} className="aspect-auto h-56 w-full">
      <BarChart data={data} margin={{ left: 0, right: 0, top: 8 }} barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="run" tickLine={false} axisLine={false} />
        <YAxis width={74} tickLine={false} axisLine={false} tickFormatter={format} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => `try ${items[0]?.payload.run}`}
              formatter={(value, name) =>
                row(ARM_LABEL[name as ArmName], format(Number(value)), fill(name as ArmName))
              }
            />
          }
        />
        {ARMS.map((arm) => (
          <Bar
            key={arm}
            dataKey={arm}
            fill={`var(--color-${arm})`}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** Estimated spend adding up over the runs shown. */
export function SpendChart({ pairs }: { pairs: Pair[] }) {
  const totals = { baseline: 0, optimized: 0 };
  const data = [
    { run: 0, ...totals },
    ...pairs.map((p, i) => {
      totals.baseline += p.baseline.costUsd;
      totals.optimized += p.optimized.costUsd;
      return { run: i + 1, ...totals };
    }),
  ];
  return (
    <ChartContainer config={arms} className="aspect-auto h-48 w-full">
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <defs>
          {ARMS.map((arm) => (
            <linearGradient key={arm} id={`spend-${arm}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={fill(arm)} stopOpacity={0.4} />
              <stop offset="100%" stopColor={fill(arm)} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="run" tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis width={74} tickLine={false} axisLine={false} tickFormatter={dollars} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => `after ${items[0]?.payload.run} tries`}
              formatter={(value, name) =>
                row(ARM_LABEL[name as ArmName], dollars(Number(value)), fill(name as ArmName))
              }
            />
          }
        />
        {ARMS.map((arm) => (
          <Area
            key={arm}
            type="linear"
            dataKey={arm}
            stroke={fill(arm)}
            strokeWidth={2}
            fill={`url(#spend-${arm})`}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

/** What the median task costs, split into what is sent and what is generated. */
export function CostSplitChart({
  pairs,
  pricing,
}: {
  pairs: Pair[];
  pricing: { input: number; output: number };
}) {
  const data = ARMS.map((arm) => ({
    arm,
    input: (median(pairs.map((p) => p[arm].inputTokens)) * pricing.input) / 1e6,
    output: (median(pairs.map((p) => p[arm].outputTokens)) * pricing.output) / 1e6,
    inputTokens: median(pairs.map((p) => p[arm].inputTokens)),
    outputTokens: median(pairs.map((p) => p[arm].outputTokens)),
  }));
  return (
    <>
      <ChartContainer config={arms} className="aspect-auto h-48 w-full">
        <BarChart data={data} margin={{ left: 0, right: 0, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="arm"
            tickLine={false}
            axisLine={false}
            tickFormatter={(arm: ArmName) => ARM_LABEL[arm]}
          />
          <YAxis width={74} tickLine={false} axisLine={false} tickFormatter={dollars} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                formatter={(value, name, item) =>
                  row(
                    `text ${name === "input" ? "read" : "written"}, ${compact(item.payload[`${name}Tokens`])} tokens`,
                    dollars(Number(value)),
                    fill(item.payload.arm),
                  )
                }
              />
            }
          />
          {(["input", "output"] as const).map((part) => (
            <Bar
              key={part}
              dataKey={part}
              stackId="cost"
              maxBarSize={72}
              stroke="var(--background)"
              strokeWidth={2}
            >
              {data.map((d) => (
                <Cell key={d.arm} fill={fill(d.arm)} fillOpacity={part === "input" ? 1 : 0.45} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
      <ul className="flex gap-4 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-foreground" />
          text read
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-foreground opacity-45" />
          text written
        </li>
      </ul>
    </>
  );
}
