import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRuntimeEvent, type RuntimeEvent } from "@runto/protocol";

export const dynamic = "force-dynamic";

async function events(): Promise<RuntimeEvent[]> {
  try {
    return (
      await readFile(
        process.env.NAVO_EVENT_LOG ?? resolve(process.cwd(), "../../runtime-events.jsonl"),
        "utf8",
      )
    )
      .split("\n")
      .filter(Boolean)
      .slice(-200)
      .flatMap((line) => {
        try {
          return [parseRuntimeEvent(JSON.parse(line))];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export default async function Page() {
  const traceEvents = await events();
  const runs = traceEvents.filter((event) => event.type === "run.completed");
  const modelEvents = traceEvents.filter((event) => event.type === "model.completed");
  const toolEvents = traceEvents.filter((event) => event.type === "tool.completed");
  const success = runs.filter((event) => event.success !== false).length;
  const latency = runs.length
    ? Math.round(runs.reduce((sum, event) => sum + (event.durationMs ?? 0), 0) / runs.length)
    : 0;
  return (
    <main>
      <div className="top">
        <div>
          <div className="eyebrow">Navo / local portal</div>
          <h1>Computer-speed traces.</h1>
          <p>
            One event protocol for control runs, optimized treatment, policies, performance, usage,
            and billing seams.
          </p>
          <a href="/benchmarks">Open measured benchmark evidence →</a>
        </div>
        <div className="badge">● local, no account required</div>
      </div>
      <section className="grid">
        <div className="card">
          <div className="label">Successful runs</div>
          <div className="value">
            {success}/{runs.length}
          </div>
        </div>
        <div className="card">
          <div className="label">Avg run latency</div>
          <div className="value">{latency}ms</div>
        </div>
        <div className="card">
          <div className="label">Model boundaries</div>
          <div className="value">{modelEvents.length}</div>
        </div>
        <div className="card">
          <div className="label">Tool boundaries</div>
          <div className="value">{toolEvents.length}</div>
        </div>
      </section>
      <section className="panel">
        <h2>Recent traces</h2>
        {traceEvents
          .slice(-12)
          .reverse()
          .map((event) => (
            <div className="row" key={event.id}>
              <div>
                <div className="event">{event.type}</div>
                <div className="muted">
                  {event.runId ?? "no run"} · {event.tool ?? event.model ?? "runtime"}
                </div>
              </div>
              <div className="muted">
                {event.durationMs
                  ? `${Math.round(event.durationMs)}ms`
                  : new Date(event.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
        {!traceEvents.length && (
          <p>No JSONL events yet. Run the example agent or set NAVO_EVENT_LOG.</p>
        )}
      </section>
      <section className="grid">
        <div className="panel">
          <h2>Policies</h2>
          <div className="row">
            <span className="muted">Write speculation</span>
            <span className="pill">blocked</span>
          </div>
          <div className="row">
            <span className="muted">Input validation</span>
            <span className="pill">enabled</span>
          </div>
        </div>
        <div className="panel">
          <h2>Authentication</h2>
          <div className="row">
            <span className="muted">Local mode</span>
            <span className="pill">no account</span>
          </div>
          <div className="row">
            <span className="muted">Managed auth</span>
            <span className="muted">Clerk adapter seam</span>
          </div>
        </div>
        <div className="panel">
          <h2>Usage & billing</h2>
          <div className="row">
            <span className="muted">Event cost data</span>
            <span className="pill">protocol-ready</span>
          </div>
          <div className="row">
            <span className="muted">Stripe integration</span>
            <span className="muted">hosted adapter seam</span>
          </div>
        </div>
      </section>
    </main>
  );
}
