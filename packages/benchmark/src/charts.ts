import type { BenchmarkResult, BenchmarkRun } from "./index.js";

export interface BenchmarkChartOptions {
  provider?: string;
  model?: string;
  live?: boolean;
  description?: string;
}

export interface BenchmarkChartBundle {
  latency: string;
  summary: string;
  frontier: string;
}

export interface ToolSchedulingChartOptions {
  toolCount: number;
  toolDelayMs: number;
  maxConcurrency: number;
  taskCount: number;
}

const COLORS = {
  background: "#f7f7f4",
  card: "#ffffff",
  ink: "#171717",
  muted: "#626262",
  grid: "#e8e8e1",
  control: "#2f79c9",
  treatment: "#ef6b2e",
  failure: "#b42318",
  neutral: "#d8d8cf",
  neutralDark: "#898982",
};

const FONT = "Inter, Helvetica Neue, Arial, sans-serif";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatMs(value: number | null): string {
  if (value === null) return "n/a";
  return `${Math.round(value).toLocaleString()} ms`;
}

function formatUsd(value: number | null): string {
  if (value === null) return "n/a";
  if (!finite(value)) return "n/a";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(3)}`;
}

function improvement(control: number | null, treatment: number | null): number | null {
  if (!finite(control) || control === 0 || !finite(treatment)) return null;
  return Math.round((1 - treatment / control) * 1000) / 10;
}

function formatImprovement(value: number | null): string {
  if (value === null) return "not available";
  return `${value >= 0 ? "↓" : "↑"} ${Math.abs(value).toFixed(1)}% vs control`;
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

function niceMax(value: number): number {
  if (!finite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const multiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiple * magnitude;
}

function svgShell(
  title: string,
  subtitle: string,
  body: string,
  note: string,
  width = 1600,
  height = 980,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" fill="${COLORS.background}"/>
  <rect x="44" y="36" width="1512" height="908" rx="30" fill="${COLORS.card}"/>
  <text x="800" y="98" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="36" font-weight="700">${escapeXml(title)}</text>
  <text x="800" y="139" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="18">${escapeXml(subtitle)}</text>
  ${body}
  <text x="178" y="895" fill="${COLORS.muted}" font-family="${FONT}" font-size="15">${escapeXml(note)}</text>
  </svg>`;
}

function legend(x: number, y: number): string {
  return `<g font-family="${FONT}" font-size="16" fill="${COLORS.ink}">
    <line x1="${x}" y1="${y - 5}" x2="${x + 25}" y2="${y - 5}" stroke="${COLORS.control}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${x + 12}" cy="${y - 5}" r="7" fill="${COLORS.control}"/>
    <text x="${x + 38}" y="${y}">Control</text>
    <line x1="${x + 130}" y1="${y - 5}" x2="${x + 155}" y2="${y - 5}" stroke="${COLORS.treatment}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${x + 142}" cy="${y - 5}" r="7" fill="${COLORS.treatment}"/>
    <text x="${x + 168}" y="${y}">Treatment</text>
  </g>`;
}

function latencyChart(result: BenchmarkResult, options: BenchmarkChartOptions): string {
  const control = result.control.runs;
  const treatment = result.treatment.runs;
  const count = Math.max(control.length, treatment.length, 1);
  const maxLatency = niceMax(
    Math.max(1, ...control.map((run) => run.latencyMs), ...treatment.map((run) => run.latencyMs)),
  );
  const plot = { x: 180, y: 195, width: 1190, height: 580 };
  const xFor = (index: number): number =>
    count === 1 ? plot.x + plot.width / 2 : plot.x + (index / (count - 1)) * plot.width;
  const yFor = (value: number): number => plot.y + plot.height - (value / maxLatency) * plot.height;
  const ticks = Array.from({ length: 6 }, (_, index) => (maxLatency * index) / 5);
  const grid = ticks
    .map((tick) => {
      const y = yFor(tick);
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="${COLORS.grid}" stroke-width="2"/>
        <text x="${plot.x - 22}" y="${y + 6}" text-anchor="end" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">${Math.round(tick).toLocaleString()}</text>`;
    })
    .join("");
  const xTicks = Array.from({ length: count }, (_, index) => {
    const x = xFor(index);
    return `<line x1="${x}" y1="${plot.y + plot.height}" x2="${x}" y2="${plot.y + plot.height + 9}" stroke="${COLORS.ink}" stroke-width="2"/>
      <text x="${x}" y="${plot.y + plot.height + 35}" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">Task ${index + 1}</text>`;
  }).join("");
  const line = (runs: BenchmarkRun[], color: string, offset: number): string => {
    const paths: string[] = [];
    let points: string[] = [];
    for (const [index, run] of runs.entries()) {
      if (!run.success) {
        if (points.length > 1)
          paths.push(
            `<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
          );
        points = [];
        continue;
      }
      points.push(`${xFor(index) + offset},${yFor(run.latencyMs)}`);
    }
    if (points.length > 1)
      paths.push(
        `<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    const markers = runs
      .map((run, index) => {
        const x = xFor(index) + offset;
        const y = yFor(run.latencyMs);
        const markerColor = run.success ? color : COLORS.failure;
        const label = run.success
          ? `${Math.round(run.latencyMs).toLocaleString()} ms`
          : `${run.timedOut ? "TIMEOUT" : "FAILED"} • ${Math.round(run.latencyMs).toLocaleString()} ms`;
        return `<title>${escapeXml(run.error ?? (run.success ? "Successful attempt" : "Failed attempt"))}</title>
          <circle cx="${x}" cy="${y}" r="10" fill="${markerColor}" stroke="${COLORS.card}" stroke-width="4"/>
          ${run.success ? "" : `<line x1="${x - 7}" y1="${y - 7}" x2="${x + 7}" y2="${y + 7}" stroke="${COLORS.card}" stroke-width="3"/><line x1="${x + 7}" y1="${y - 7}" x2="${x - 7}" y2="${y + 7}" stroke="${COLORS.card}" stroke-width="3"/>`}
          <text x="${x}" y="${y - 20}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="14" font-weight="600">${escapeXml(label)}</text>`;
      })
      .join("");
    return `${paths.join("")}${markers}`;
  };
  const p95Delta = improvement(result.control.p95LatencyMs, result.treatment.p95LatencyMs);
  const attemptP95Delta = improvement(
    result.control.attemptP95LatencyMs,
    result.treatment.attemptP95LatencyMs,
  );
  const failures = result.control.failureCount + result.treatment.failureCount;
  const provider = options.provider ?? (options.live ? "Vercel AI Gateway" : "deterministic mock");
  const model = options.model ? ` • ${options.model}` : "";
  const description = options.description ? ` • ${options.description}` : "";
  const subtitle = `${provider}${model} • ${count} benchmark task${count === 1 ? "" : "s"} • ${failures} failed • lower is better${description}`;
  const note =
    count < 4
      ? `Small sample (n=${count}); failed attempts are marked red. Expand NAVO_BENCHMARK_TASKS before making a general claim.`
      : `Successful p95 change: ${formatImprovement(p95Delta)}. All-attempt p95 change: ${formatImprovement(attemptP95Delta)}.`;
  const body = `<g>
    ${grid}
    ${xTicks}
    <line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="${COLORS.ink}" stroke-width="3"/>
    <line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="${COLORS.ink}" stroke-width="3"/>
    ${line(control, COLORS.control, count === 1 ? -14 : 0)}
    ${line(treatment, COLORS.treatment, count === 1 ? 14 : 0)}
    <text x="${plot.x + plot.width / 2}" y="${plot.y + plot.height + 78}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="600">Benchmark task (ordered)</text>
    <text x="70" y="${plot.y + plot.height / 2}" transform="rotate(-90 70 ${plot.y + plot.height / 2})" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="600">End-to-end latency (ms)</text>
    ${legend(plot.x + plot.width - 225, plot.y - 28)}
    <g transform="translate(1030 235)">
      <rect width="295" height="108" rx="18" fill="${COLORS.background}" stroke="${COLORS.grid}" stroke-width="2"/>
      <text x="22" y="34" fill="${COLORS.muted}" font-family="${FONT}" font-size="15">Successful p95</text>
      <text x="22" y="72" fill="${COLORS.ink}" font-family="${FONT}" font-size="20" font-weight="700">${escapeXml(formatImprovement(p95Delta))}</text>
    </g>
  </g>`;
  return svgShell("Runtime latency by task", subtitle, body, note);
}

function summaryChart(result: BenchmarkResult, options: BenchmarkChartOptions): string {
  type Panel = {
    title: string;
    kind: "latency" | "success" | "cost";
    control: number | null;
    treatment: number | null;
    format: (value: number) => string;
    change: number | null;
  };
  const panels = [
    {
      title: "Successful p95 latency",
      kind: "latency",
      control: result.control.p95LatencyMs,
      treatment: result.treatment.p95LatencyMs,
      format: (value: number) => formatMs(value),
      change: improvement(result.control.p95LatencyMs, result.treatment.p95LatencyMs),
    },
    {
      title: "Success rate",
      kind: "success",
      control: result.control.successRate * 100,
      treatment: result.treatment.successRate * 100,
      format: (value: number) => `${value.toFixed(1)}%`,
      change: (result.treatment.successRate - result.control.successRate) * 100,
    },
    {
      title: "Cost per successful task",
      kind: "cost",
      control: result.control.costPerSuccessfulTaskUsd,
      treatment: result.treatment.costPerSuccessfulTaskUsd,
      format: (value: number) => formatUsd(value),
      change: improvement(
        result.control.costPerSuccessfulTaskUsd,
        result.treatment.costPerSuccessfulTaskUsd,
      ),
    },
  ] satisfies Panel[];
  const body = panels
    .map((panel, panelIndex) => {
      const x = 150 + panelIndex * 455;
      const y = 235;
      const chartHeight = 395;
      const baseline = y + chartHeight;
      const values = [panel.control, panel.treatment].filter(finite);
      const unknownCost = panel.kind === "cost" && [panel.control, panel.treatment].includes(null);
      const pricingUnavailable =
        panel.kind === "cost" &&
        !unknownCost &&
        values.length > 0 &&
        values.every((value) => value === 0);
      const hasValues = values.length > 0 && !pricingUnavailable;
      const usableMax = panel.kind === "success" ? 100 : niceMax(Math.max(...values, 1));
      const bar = (value: number | null, barX: number, color: string, label: string): string => {
        const hasValue = hasValues && finite(value);
        const height = hasValue ? ((value ?? 0) / usableMax) * 300 : 0;
        return `${hasValue ? `<rect x="${barX}" y="${baseline - height}" width="92" height="${height}" rx="12" fill="${color}"/>` : ""}
          <text x="${barX + 46}" y="${baseline + 33}" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="15">${label}</text>
          <text x="${barX + 46}" y="${Math.max(y + 25, baseline - height - 16)}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="16" font-weight="700">${escapeXml(hasValue ? panel.format(value ?? 0) : "n/a")}</text>`;
      };
      const scale = hasValues
        ? Array.from({ length: 5 }, (_, index) => {
            const value = (usableMax * index) / 4;
            const lineY = baseline - (value / usableMax) * 300;
            return `<line x1="${x}" y1="${lineY}" x2="${x + 330}" y2="${lineY}" stroke="${COLORS.grid}" stroke-width="2"/>
              <text x="${x - 16}" y="${lineY + 5}" text-anchor="end" fill="${COLORS.muted}" font-family="${FONT}" font-size="13">${escapeXml(panel.format(value))}</text>`;
          }).join("")
        : "";
      const message = hasValues
        ? ""
        : `<rect x="${x + 28}" y="${y + 115}" width="275" height="150" rx="18" fill="${COLORS.background}" stroke="${COLORS.grid}" stroke-width="2"/>
          <text x="${x + 165}" y="${y + 175}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="20" font-weight="700">${unknownCost ? "Cost unavailable" : pricingUnavailable ? "Pricing unavailable" : "No successful runs"}</text>
          <text x="${x + 165}" y="${y + 211}" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="14">${unknownCost ? "A failed attempt has unknown usage" : pricingUnavailable ? "Set benchmark token prices" : "Failure data is shown separately"}</text>`;
      const change =
        panel.kind === "success" && panel.change !== null
          ? `${panel.change >= 0 ? "↑" : "↓"} ${Math.abs(panel.change).toFixed(1)} pts vs control`
          : formatImprovement(panel.change);
      return `<g>
        <text x="${x + 165}" y="${y - 34}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="700">${escapeXml(panel.title)}</text>
        ${scale}
        <line x1="${x}" y1="${baseline}" x2="${x + 330}" y2="${baseline}" stroke="${COLORS.ink}" stroke-width="3"/>
        ${bar(panel.control, x + 63, COLORS.control, "Control")}
        ${bar(panel.treatment, x + 185, COLORS.treatment, "Treatment")}
        ${message}
        <text x="${x + 165}" y="${baseline + 92}" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="15">${escapeXml(change)}</text>
      </g>`;
    })
    .join("");
  const provider = options.provider ?? (options.live ? "Vercel AI Gateway" : "deterministic mock");
  const model = options.model ? ` • ${options.model}` : "";
  const description = options.description ? ` • ${options.description}` : "";
  const count = Math.max(result.control.runs.length, result.treatment.runs.length);
  const failures = result.control.failureCount + result.treatment.failureCount;
  const subtitle = `${provider}${model} • control versus treatment summary • n=${count} • ${failures} failed attempt${failures === 1 ? "" : "s"}${description}`;
  return svgShell(
    "Runtime benchmark summary",
    subtitle,
    body,
    "Control is model-selected serial reads; treatment is a validated read-only fan-out with compact results. Cost uses reported tokens × configured rates.",
  );
}

function frontierChart(result: BenchmarkResult, options: BenchmarkChartOptions): string {
  const points = [
    {
      label: "Control",
      cost: result.control.costPerSuccessfulTaskUsd,
      success: result.control.successRate * 100,
      color: COLORS.control,
    },
    {
      label: "Treatment",
      cost: result.treatment.costPerSuccessfulTaskUsd,
      success: result.treatment.successRate * 100,
      color: COLORS.treatment,
    },
  ];
  const [controlPoint, treatmentPoint] = points;
  if (!controlPoint || !treatmentPoint) throw new Error("Benchmark frontier requires two points");
  const valid = points.every((point) => finite(point.cost) && point.cost > 0);
  const plot = { x: 205, y: 205, width: 1130, height: 530 };
  const provider = options.provider ?? (options.live ? "Vercel AI Gateway" : "deterministic mock");
  const model = options.model ? ` • ${options.model}` : "";
  const description = options.description ? ` • ${options.description}` : "";
  const subtitle = `${provider}${model} • aggregate control/treatment frontier • logarithmic cost axis${description}`;
  if (!valid) {
    const reason = points.some((point) => point.cost === null)
      ? "Cost per successful task is unavailable for a failed group."
      : "Set token prices before making a cost claim.";
    const body = `<g>
      <rect x="350" y="330" width="900" height="220" rx="28" fill="${COLORS.background}" stroke="${COLORS.grid}" stroke-width="2"/>
      <text x="800" y="410" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="28" font-weight="700">Cost chart unavailable</text>
      <text x="800" y="455" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">${reason}</text>
      <text x="800" y="487" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">${reason.startsWith("Set") ? "NAVO_BENCHMARK_INPUT_COST_PER_MILLION / OUTPUT_COST_PER_MILLION" : "Use the summary chart for failure and success rates."}</text>
    </g>`;
    return svgShell(
      "Runtime cost-success frontier",
      subtitle,
      body,
      "No cost claim is rendered when pricing or successful-run cost data is missing.",
    );
  }
  const controlCost = controlPoint.cost;
  const treatmentCost = treatmentPoint.cost;
  if (!finite(controlCost) || !finite(treatmentCost))
    throw new Error("Benchmark frontier requires finite costs");
  const logValues = points.map((point) => Math.log10(point.cost as number));
  let minLog = Math.min(...logValues);
  let maxLog = Math.max(...logValues);
  if (minLog === maxLog) {
    minLog -= 0.5;
    maxLog += 0.5;
  } else {
    const padding = (maxLog - minLog) * 0.2;
    minLog -= padding;
    maxLog += padding;
  }
  const xFor = (cost: number): number =>
    plot.x + ((Math.log10(cost) - minLog) / (maxLog - minLog)) * plot.width;
  const yFor = (success: number): number => plot.y + plot.height - (success / 100) * plot.height;
  const ticks = [0, 20, 40, 60, 80, 100]
    .map((value) => {
      const y = yFor(value);
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="${COLORS.grid}" stroke-width="2"/>
        <text x="${plot.x - 22}" y="${y + 6}" text-anchor="end" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">${value}%</text>`;
    })
    .join("");
  const connector = `<line x1="${xFor(controlCost)}" y1="${yFor(controlPoint.success)}" x2="${xFor(treatmentCost)}" y2="${yFor(treatmentPoint.success)}" stroke="${COLORS.neutralDark}" stroke-width="3" stroke-dasharray="8 8"/>`;
  const markers = points
    .map((point) => {
      const x = xFor(point.cost as number);
      const y = yFor(point.success);
      return `<circle cx="${x}" cy="${y}" r="14" fill="${point.color}" stroke="${COLORS.card}" stroke-width="5"/>
        <text x="${x + 22}" y="${y - 18}" fill="${COLORS.ink}" font-family="${FONT}" font-size="18" font-weight="700">${point.label}</text>
        <text x="${x + 22}" y="${y + 10}" fill="${COLORS.muted}" font-family="${FONT}" font-size="15">${escapeXml(formatUsd(point.cost))} • ${point.success.toFixed(1)}%</text>`;
    })
    .join("");
  const body = `<g>
    ${ticks}
    <line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="${COLORS.ink}" stroke-width="3"/>
    <line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="${COLORS.ink}" stroke-width="3"/>
    ${connector}
    ${markers}
    <text x="${plot.x + plot.width / 2}" y="${plot.y + plot.height + 78}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="600">Cost per successful task (USD, log scale)</text>
    <text x="85" y="${plot.y + plot.height / 2}" transform="rotate(-90 85 ${plot.y + plot.height / 2})" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="600">Success rate (%)</text>
  </g>`;
  return svgShell(
    "Runtime cost-success frontier",
    subtitle,
    body,
    "Two aggregate points are shown. Use the task-level chart for latency spread and increase the benchmark sample before generalizing.",
  );
}

export function renderBenchmarkCharts(
  result: BenchmarkResult,
  options: BenchmarkChartOptions = {},
): BenchmarkChartBundle {
  return {
    latency: latencyChart(result, options),
    summary: summaryChart(result, options),
    frontier: frontierChart(result, options),
  };
}

export function renderToolSchedulingChart(
  result: BenchmarkResult,
  options: ToolSchedulingChartOptions,
): string {
  const controlToolPhase = metricP95(result.control.runs, "toolDurationMs");
  const treatmentToolPhase = metricP95(result.treatment.runs, "toolDurationMs");
  const usesToolPhase = controlToolPhase !== null && treatmentToolPhase !== null;
  const control = controlToolPhase ?? result.control.p95LatencyMs;
  const treatment = treatmentToolPhase ?? result.treatment.p95LatencyMs;
  const speedup =
    finite(control) && finite(treatment) && treatment > 0
      ? Math.round((control / treatment) * 10) / 10
      : null;
  const values = [control, treatment].filter(finite);
  const max = niceMax(Math.max(...values, 1));
  const plot = { x: 240, y: 250, width: 1_000, height: 390 };
  const baseline = plot.y + plot.height;
  const yFor = (value: number): number => baseline - (value / max) * 300;
  const bar = (value: number | null, x: number, color: string, label: string): string => {
    const hasValue = finite(value);
    const height = hasValue ? ((value ?? 0) / max) * 300 : 0;
    return `${hasValue ? `<rect x="${x}" y="${baseline - height}" width="180" height="${height}" rx="18" fill="${color}"/>` : ""}
      <text x="${x + 90}" y="${baseline + 42}" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="18">${label}</text>
      <text x="${x + 90}" y="${Math.max(plot.y + 30, baseline - height - 18)}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="700">${hasValue ? formatMs(value ?? 0) : "n/a"}</text>`;
  };
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = (max * index) / 4;
    const y = yFor(value);
    return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="${COLORS.grid}" stroke-width="2"/>
      <text x="${plot.x - 22}" y="${y + 6}" text-anchor="end" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">${formatMs(value)}</text>`;
  }).join("");
  const body = `<g>
    ${ticks}
    <line x1="${plot.x}" y1="${baseline}" x2="${plot.x + plot.width}" y2="${baseline}" stroke="${COLORS.ink}" stroke-width="3"/>
    ${bar(control, plot.x + 250, COLORS.control, "Control · serial")}
    ${bar(treatment, plot.x + 570, COLORS.treatment, "Treatment · parallel")}
    <text x="${plot.x + plot.width / 2}" y="${baseline + 100}" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="24" font-weight="600">${usesToolPhase ? "Tool execution p95 latency (ms)" : "End-to-end latency (ms)"}</text>
    <text x="80" y="${plot.y + plot.height / 2}" transform="rotate(-90 80 ${plot.y + plot.height / 2})" text-anchor="middle" fill="${COLORS.ink}" font-family="${FONT}" font-size="22" font-weight="600">End-to-end tool phase (ms)</text>
    <g transform="translate(1030 250)">
      <rect width="300" height="130" rx="20" fill="${COLORS.background}" stroke="${COLORS.grid}" stroke-width="2"/>
      <text x="22" y="38" fill="${COLORS.muted}" font-family="${FONT}" font-size="16">Measured speedup</text>
      <text x="22" y="88" fill="${COLORS.ink}" font-family="${FONT}" font-size="34" font-weight="700">${speedup === null ? "n/a" : `${speedup.toFixed(1)}×`}</text>
    </g>
  </g>`;
  const subtitle = `${usesToolPhase ? "same end-to-end incident benchmark" : "deterministic runtime benchmark"} • ${options.toolCount} independent reads × ${options.toolDelayMs} ms • max concurrency ${options.maxConcurrency} • n=${options.taskCount}`;
  return svgShell(
    "Parallel tool scheduling",
    subtitle,
    body,
    usesToolPhase
      ? "Tool-phase p95 comes from runtime telemetry for the same task; it excludes Gateway/model latency, while the main charts show end-to-end performance."
      : "Fallback measurement uses the local runtime; it excludes Gateway/model latency and is not an end-to-end provider claim.",
  );
}
