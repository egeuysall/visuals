# visuals

What if we build something that can make any AI model 5x cheaper and faster, by optimizing tool calling, tool results and reasoning? Then show the data.

visuals runs the same agent task twice, a baseline and an optimized runtime, from a terminal in the browser, and charts where the time and money went.

## What existed before, and what is new here

| | |
| --- | --- |
| **Prior work** | The agent runtime (`packages/`, `examples/`, `runtime-go/`, `services/`, `apps/dashboard`) is a snapshot of [egeuysall/sdk](https://github.com/egeuysall/sdk) at `497485e`, written before this repository (commits dated 2026-08-05). It is the first commit here. The recorded GPT-5 benchmark in `apps/web/src/data` was also produced then. |
| **Prior work** | The look, the UI components and the terminal pattern come from [kaibo](https://github.com/egeuysall/kaibo). Memory uses the published `kaibo` SDK. |
| **New** | Everything after the first commit: `apps/web`, `apps/model`, and two SDK fixes (`node:sqlite` under Turbopack, and compacted tool results dropping the facts the model needed). |

## Numbers, and how far to trust them

| Source | Cost | End to end | Input tokens | Sample |
| --- | --- | --- | --- | --- |
| `glm-4.7-flash` on Workers AI, this app | 7.2x cheaper | 2.7x faster | 11.0x fewer | median of 3 local runs, 2026-11-26 |
| `gpt-5`, recorded with the SDK | 4.1x cheaper | 1.2x faster | 14.5x fewer | 20 runs per arm, 2026-08-05 |

- One task (an incident investigation with twelve read-only tools over made-up data, 120 ms each). Not a claim about "any model" or any workload.
- 5x cheaper held in these samples on one model. **5x faster end to end did not**: only the tool phase gets there.
- The optimized arm turns the model's reasoning off by default. That is a large part of the gain on `glm-4.7-flash`. Type `run --thinking` to see the gain without that.
- The "key facts" figure is a keyword check, not a grade. Read the answers.
- The table's first row was measured before lookups became required. Three runs afterwards, with different questions: 6.8x to 10.6x cheaper and 2.2x to 2.7x faster.
- The optimized answer can be worse. In those three runs it checked 5 to 12 of 12 sources and found 3 or 4 of 4 key facts, where standard found 4 each time.
- Both ways now run at the same time. A model must look something up before it answers. An answer with no lookups is never counted as a saving, because one such run invented its facts.
- The arms can make different numbers of tool calls. The terminal says when they do.
- The recorded benchmark was produced before the preview fix, and its success check only looked at the shape of the report. Today's `examples/benchmark` sets low reasoning on both arms, so do not attribute its savings to reasoning.
- Costs are estimates from token counts and list prices, not an invoice.

## Run it

Node 22.14+, pnpm, and a Cloudflare account (`wrangler login`).

```bash
pnpm install
pnpm build
cp apps/web/.env.example apps/web/.env.local   # add the kaibo values
pnpm visuals                                   # model worker on :8787, web on :3000
```

Sign up with a lowercase username and a 4 digit PIN, then press compare or type a question. `help` lists the commands. Advanced: `run --thinking`, `--no-parallel`, `--no-compact`, `--no-schema`.

## How it works

- `apps/web`: Next.js. Server code runs both arms through `@runto/core`, streams the terminal output, and records a span for every model and tool call.
- `apps/model`: a small Worker around the Workers AI binding. Without `MODEL_PROXY_TOKEN` it only answers on localhost.
- **Memory**: kaibo (set `KAIBO_PROJECT` if your key covers every project), scoped with `withUser("visuals:<account id>")`. The id comes from the signed session cookie, never from the client. Recalled memory goes into both arms. Only what you type is saved, not model output.
- **Auth**: username and PIN, scrypt hashed. Five wrong PINs lock the account for 15 minutes. A 4 digit PIN is demo-grade: do not protect anything valuable with it.
- **Storage**: SQLite in `apps/web/.data`. It needs a persistent disk, so this does not run on serverless hosting as is.
- **Limits**: sign-up is open, and `LIVE_RUNS_PER_DAY` is the only cap on spend across all users.

---

# The runtime (imported)

# Navo

Framework-neutral TypeScript runtime for tool-using agents. It keeps a
transparent control path, then lets discovery, schema/result/context
compilation, freshness-aware caching, safe scheduling, and read-only
speculation be enabled independently.

## Quick start

```bash
pnpm install
pnpm test
pnpm build
pnpm --filter navo-example-agent start
pnpm --filter navo-example-research-agent start
pnpm --filter navo-example-investigation-agent start
pnpm benchmark
pnpm benchmark:general
```

The examples run with deterministic mock providers when no Gateway key is
present. Set `AI_GATEWAY_API_KEY` in a local `.env` to make Vercel AI Gateway
the default provider:

```bash
cp .env.example .env
# edit .env and set AI_GATEWAY_API_KEY
pnpm --filter navo-example-research-agent start
```

The examples then use `createVercelProvider({ gateway: true })`. Direct
`createOpenAIProvider` and `createAnthropicProvider` adapters remain available.

The local CLI is available with `node packages/cli/bin/navo.js help`. Start the
loopback gateway with `pnpm --filter @runto/gateway start`.
`pnpm benchmark` runs a control-vs-treatment production-incident benchmark and
prints p95 latency, success rate, cost, and percentage deltas. Both groups use
the same model-driven task and provider settings. The task asks GPT-5 to
investigate ENG-142 using twelve independent read-only sources
(issue, comments, commits, logs, deployment, metrics, flags, runbooks, and
incident history), then produce a root-cause report. Control disables parallel
execution; treatment uses validated read-only scheduling, bounded parallel
execution, result compaction, and explicit safe batching guidance. With
`AI_GATEWAY_API_KEY` present it uses
Gateway by default; set
`NAVO_BENCHMARK_LIVE=0` to force the deterministic local benchmark. Live mode
is a local measurement, not a provider performance claim:

```bash
NAVO_BENCHMARK_LIVE=1 pnpm benchmark
```

Each run also writes `artifacts/benchmarks/latest/benchmark-results.json` and
four SVG charts: `latency-by-task.svg`, `benchmark-summary.svg`,
`cost-success-frontier.svg`, and `tool-scheduling.svg`. The tool chart now
uses the runtime's measured tool-phase p95 from the same incident task; it
does not relabel end-to-end model latency as tool speed. The fixture uses
twelve independent 120 ms reads and concurrency twelve, so a successful
treatment should approach the theoretical 12x tool-phase ceiling while the
end-to-end chart still includes real GPT-5/Gateway latency. The frontier chart
stays intentionally blank when token pricing or successful-run cost data is
missing instead of inventing cost data. Failed attempts are marked in red,
excluded from successful p95, and kept in the raw attempt-latency data.

Control is the normal model-driven loop: GPT-5 selects the tools and the runtime
executes them serially. Treatment uses the same model-driven loop, then batches
independent reads through the bounded scheduler and compacts large results
before the final model call. The summary's cost is estimated from reported
input and output tokens multiplied by the configured rates; it is not an
invoice.
End-to-end latency includes Gateway/model time. Tool-phase latency excludes
that model time, which is why the tool chart can show a larger improvement.

Live mode defaults to three tasks to make p95 less dependent on one request;
set `NAVO_BENCHMARK_TASKS` lower if you are testing a paid key. Set
`NAVO_BENCHMARK_INPUT_COST_PER_MILLION` and
`NAVO_BENCHMARK_OUTPUT_COST_PER_MILLION` to your model's current pricing if you
want meaningful cost metrics; the runtime cannot infer gateway pricing safely.
The defaults in `.env.example` are the published GPT-5 rates and should be
updated when the Gateway model changes. `NAVO_INCIDENT_TOOL_DELAY_MS` and
`NAVO_INCIDENT_MAX_CONCURRENCY` control the local I/O fixture and scheduler
ceiling; they do not change the model or claim provider-side speed.

## SDK

```ts
import { createMockProvider, createRuntime } from "@runto/core";

const runtime = createRuntime({
  provider: createMockProvider(async () => ({ text: "done", toolCalls: [] })),
  tools: [],
  optimizations: { cache: false, parallelExecution: false },
});

const result = await runtime.run({ task: "Summarize the state" });
console.log(result.output, result.metrics);
```

The stable event schema lives in `@runto/protocol`. Events can
be sent to memory, JSONL, OpenTelemetry-compatible exporters, or a managed
ingestion service. Telemetry strings are redacted by default; enable
`captureContent` only in a trusted environment. The local gateway exposes the
same event records and tool registry through HTTP.

## Package map

- `packages/core`: runtime, tool registry, discovery, compilers, mock provider
- `packages/protocol`: versioned Zod event protocol and JSON-schema projection
- `packages/mcp`: MCP aggregation/gateway and discovery tools
- `packages/telemetry`: memory, buffered JSONL, Convex, and OTel exporters
- `packages/cache`: memory, filesystem, SQLite, and Redis/Valkey adapters
- `packages/context`: deterministic token-budgeted context compiler
- `packages/scheduler`: dependency-aware bounded scheduler
- `packages/benchmark`: baseline/control-vs-treatment benchmark runner
- `packages/provider-vercel`: Vercel AI SDK provider adapter
- `packages/provider-openai`: direct OpenAI Responses API adapter
- `packages/provider-anthropic`: direct Anthropic Messages API adapter
- `packages/adapter-vercel-ai`: RuntimeTool-to-Vercel tool conversion
- `packages/cli`: `navo` local CLI
- `services/gateway`: local HTTP/MCP-style gateway
- `services/trace-ingestion`: JSONL event ingestion service
- `apps/dashboard`: local trace/performance/policy/usage portal
- `runtime-go`: standard-library Go runtime, OpenAI/Anthropic adapters, and safe scheduler
- `convex`: optional hosted event store deployed with the existing Convex CLI

## Honest scope

The local implementation uses memory/filesystem/SQLite adapters and a small
local dashboard. Convex is the implemented hosted event store; deploy it with
`pnpm convex:deploy` and set `NAVO_CONVEX_URL` plus
`NAVO_CONVEX_INGEST_KEY`. Raw Postgres, ClickHouse, S3, Clerk, and Stripe remain
deployment-specific integrations. Speculation is guarded read-only execution
only; no write is ever speculated. Replay, workflow memory, dependency
inference, cancellation, retries, and MCP invalidation are implemented.

The benchmark is an evidence tool, not a production-wide guarantee. A claim
requires representative workloads, live provider samples, failure cases,
warm/cold runs, and enough paired repetitions for the target traffic shape.
`pnpm benchmark:general` runs the same model-driven runtime against independent
reads, dependency chains, and write barriers. Its local I/O fixture isolates
scheduler behavior and is explicitly not an external-provider claim.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
