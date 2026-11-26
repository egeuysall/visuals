import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const dynamic = "force-dynamic";

interface Summary {
  p95LatencyMs: number | null;
  successRate: number;
  costPerSuccessfulTaskUsd: number | null;
}

interface LatestBenchmark {
  live: boolean;
  model: string;
  scenario: { taskCount: number };
  control: Summary;
  treatment: Summary;
  improvement: { p95LatencyPercent: number | null; costPerSuccessfulTaskPercent: number | null };
  toolScheduling: {
    improvement: { controlToolP95Ms: number | null; treatmentToolP95Ms: number | null };
  };
}

interface GeneralBenchmark {
  fixture: { note: string };
  results: Array<{
    workload: { id: string };
    result: { control: Summary; treatment: Summary };
    speedup: number | null;
  }>;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const root = resolve(process.cwd(), "../../artifacts/benchmarks");

export default async function BenchmarksPage() {
  const [latest, general] = await Promise.all([
    readJson<LatestBenchmark>(resolve(root, "latest/benchmark-results.json")),
    readJson<GeneralBenchmark>(resolve(root, "general/benchmark-results.json")),
  ]);
  return (
    <main>
      <div className="top">
        <div>
          <div className="eyebrow">Navo / benchmark evidence</div>
          <h1>Measured, not promised.</h1>
          <p>Control and treatment results are loaded from the latest local benchmark artifacts.</p>
        </div>
        <div className="badge">● saved evidence</div>
      </div>
      <section className="panel">
        <h2>Latest provider sample</h2>
        {latest ? (
          <>
            <p className="muted">
              {latest.live ? "Live provider" : "Deterministic fixture"} · {latest.model} · n=
              {latest.scenario.taskCount}
            </p>
            <div className="grid">
              <div className="card">
                <div className="label">End-to-end p95</div>
                <div className="value">
                  {latest.control.p95LatencyMs}ms → {latest.treatment.p95LatencyMs}ms
                </div>
              </div>
              <div className="card">
                <div className="label">Tool-phase p95</div>
                <div className="value">
                  {latest.toolScheduling.improvement.controlToolP95Ms}ms →{" "}
                  {latest.toolScheduling.improvement.treatmentToolP95Ms}ms
                </div>
              </div>
              <div className="card">
                <div className="label">Success rate</div>
                <div className="value">
                  {latest.control.successRate * 100}% → {latest.treatment.successRate * 100}%
                </div>
              </div>
              <div className="card">
                <div className="label">End-to-end delta</div>
                <div className="value">{latest.improvement.p95LatencyPercent ?? "n/a"}%</div>
              </div>
            </div>
          </>
        ) : (
          <p>No benchmark artifact found. Run `pnpm benchmark`.</p>
        )}
      </section>
      <section className="panel">
        <h2>General workload matrix</h2>
        <p className="muted">
          {general?.fixture.note ?? "Run pnpm benchmark:general to populate this matrix."}
        </p>
        {general?.results.map(({ workload, result, speedup }) => (
          <div className="row" key={workload.id}>
            <span className="event">{workload.id}</span>
            <span className="muted">
              {result.control.p95LatencyMs}ms → {result.treatment.p95LatencyMs}ms ·{" "}
              {speedup ?? "n/a"}x · {result.treatment.successRate * 100}% success
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}
