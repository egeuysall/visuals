# sdk

**What if we build something that can make any AI model 5x cheaper and faster?**

Live: [sdk.egeuysal.com](https://sdk.egeuysal.com)

Most of an agent's bill isn't the question you asked. It's how the agent works: it fetches things one at a time, reads every long tool result in full, and thinks at length before simple answers. This project changes those three things, keeps the model the same, and shows you the difference.

Ask a question on the site. The same model answers twice, the standard way and the optimized way. Your optimized answer shows first, then charts compare cost, time and how much text the model had to read.

## How far we got

11 comparisons from testing this app, on one small model (`glm-4.7-flash` on Cloudflare Workers AI). Medians:

| | Standard | Optimized | Difference |
| --- | --- | --- | --- |
| Cost per question | $0.0034 | $0.00046 | **7.4x cheaper** |
| Total time | 36.1s | 14.0s | **2.6x faster** |
| Text the model read (tokens) | 48,187 | 4,381 | **11.0x less** |
| Tool calls, wall clock | 1.47s | 133ms | **11.1x faster** |

**Cost passed 5x. Total time did not.** Speed ranged from 1.5x to 6.6x.

**The catch:** the optimized answer mentioned all four key facts in 6 of 11 tries. The standard answer did in 8. In 5 tries the optimized side also checked fewer than all twelve sources.

An earlier, larger test on GPT-5 (20 tries each way, recorded with the runtime before this repository) came out **4.1x cheaper** but only **1.2x faster**. A bigger model spends most of its time thinking and writing, which faster tool calls don't help.

### What these numbers don't show

- It is one task: investigating a made up production incident with twelve read-only tools, 120ms each. It says nothing about "any model" or other workloads.
- "Key facts" is a keyword check, not a grade of the answer.
- Most of the saving on this model comes from turning its reasoning off. Type `run --thinking` to see the gain without that.
- The 11 tries include different questions, and the app changed during testing (for example, requiring a lookup before an answer). The raw numbers are in [`apps/web/src/data/recent-tries.json`](apps/web/src/data/recent-tries.json).
- In the GPT-5 recording, the success check only looked at the shape of the report. It also predates the preview fix below, and today's benchmark script sets low reasoning on both sides, so don't credit its savings to reasoning.
- Costs are estimates from token counts and list prices, not an invoice.

## How it works

| Change | What the runtime does |
| --- | --- |
| Tool calls | Runs independent reads together, with a concurrency limit. Writes are never run speculatively. |
| Tool results | Shortens long results to a preview that keeps every field that fits, and summarizes only the ones that don't. |
| Tool schemas | Sends compact tool definitions. |
| Reasoning | Turns the model's long reasoning off for the optimized side. |

Two things we learned while testing:

- **Shortening can throw away the answer.** The first version dropped every list once one field got too big. The model said it only had "generic previews" and couldn't find the cause, while the dashboard still showed a saving. Fixed, with a test.
- **A cheap answer can be a made up one.** With reasoning off, the model once answered without looking anything up and invented regional numbers, and the app called it 17.5x cheaper. Now it has to look something up first, and an answer with no lookups never counts.

## What existed before, and what is new here

| | |
| --- | --- |
| **Prior work** | The agent runtime (`packages/`, `examples/`, `runtime-go/`, `services/`, `apps/dashboard`) is a snapshot of [egeuysall/sdk](https://github.com/egeuysall/sdk) at `497485e`, written before this repository (commits dated 2026-08-05). It is the first commit here. The GPT-5 recording was also made then. |
| **Prior work** | The look, UI components and terminal pattern come from [kaibo](https://github.com/egeuysall/kaibo). Memory uses the published `kaibo` SDK. |
| **New** | Everything after the first commit: the web app in `apps/web` (comparison terminal, charts, accounts, memory, Cloudflare deployment) and the runtime fixes: compacted results keeping the facts, running on Workers without `node:sqlite`, and validating tool input without generating code. |

The git history shows each step with its real time.

## The app

- **Next.js on Cloudflare Workers** (OpenNext). The model runs through the Workers AI binding.
- **D1** stores accounts and results.
- **Memory** with [kaibo](https://kaibo.egeuysal.com): type `remember "..."`, and later questions use it. Each account has its own memory, named by an id from the signed session cookie, never by anything the browser sends. Only what you type is saved, not model output.
- **Accounts**: a lowercase username and a 4 digit PIN. PINs are hashed with scrypt. Five wrong tries lock the account for 15 minutes, including tries sent at the same moment. A 4 digit PIN is demo grade, so don't protect anything valuable with it.
- **Limits**: 20 comparisons per account per day, 200 for the whole site, and caps on sign ups and sign ins per network address.

Commands in the box: `compare`, any question, `remember`, `recall`, `my results`, `earlier test`, `reset`, `help`. Advanced: `run --thinking`, `--no-parallel`, `--no-compact`, `--no-schema`.

## Run it locally

You need Node 22.14+, pnpm, and a Cloudflare account (`pnpm --filter visuals-web exec wrangler login`). The model calls are real and billed to that account.

```bash
pnpm install
pnpm build
cp apps/web/.env.example apps/web/.env.local   # kaibo values are optional
pnpm --filter visuals-web db:local             # create the local database
pnpm web                                       # http://localhost:3000
```

Tests: `pnpm test` for the runtime, `pnpm --filter visuals-web test` for the app.

## Deploy

Change the database id, domain and `KAIBO_PROJECT` in `apps/web/wrangler.jsonc`, then:

```bash
pnpm build
cd apps/web
pnpm exec wrangler secret put SESSION_SECRET   # 32+ random characters
pnpm exec wrangler secret put KAIBO_KEY        # optional, for memory
pnpm db:remote
pnpm cf:deploy
```

The runtime has its own documentation in [`docs/runtime.md`](docs/runtime.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
