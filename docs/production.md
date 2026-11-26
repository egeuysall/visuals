# Production runbook

## Validate before release

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm typecheck
(cd runtime-go && go test -race ./... && go vet ./...)
pnpm benchmark:general
NAVO_BENCHMARK_LIVE=1 NAVO_BENCHMARK_TASKS=20 pnpm benchmark
```

The general matrix uses the same model-driven runtime for both groups and
checks independent reads, dependency chains, and write barriers. It is a local
I/O fixture, so it validates scheduler behavior rather than provider capacity.
The live benchmark must be run with the actual provider, model, pricing, and a
representative task set before publishing a performance claim.

## Publish the SDK

The workspace product name is `navo`, and the scoped `@runto` package family
is available. First verify the package set without publishing:

```bash
pnpm release:check
```

Publish from the workspace with the release script; do not run `pnpm publish`
at the repository root, because the root is only a private workspace manifest:

```bash
pnpm release:publish
```

Configure the trusted publisher for each `@runto/*` package in npm with:

- provider: GitHub Actions
- organization or user: `egeuysall`
- repository: `sdk`
- workflow filename: `release.yml`
- allowed action: `npm publish`

The release workflow uses npm trusted publishing with GitHub Actions OIDC, so
it does not need an npm token. Advance the package versions, commit them, and
push a matching tag to publish:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Consumers can then install the SDK with:

```bash
pnpm add @runto/core @runto/provider-openai
```

## Deploy Convex event storage

Use the existing Convex CLI from the repository root. Configure a production
deployment once, set its environment variables, and deploy the functions:

```bash
pnpm convex:dev
pnpm exec convex env set NAVO_CONVEX_INGEST_KEY "use-a-secret-manager-value"
CONVEX_DEPLOYMENT=prod:your-deployment pnpm convex:deploy
```

Set `NAVO_CONVEX_URL` to the deployment HTTP-actions URL and configure the same
ingest key in the runtime or trace service. Do not put deployment keys in the
repository or browser bundle.

## Run the gateway

The gateway is safe for loopback by default. For a public deployment, require
all of the following:

```bash
NAVO_HOST=0.0.0.0
NAVO_API_KEY="secret-from-secret-manager"
NAVO_ALLOWED_TOOLS="server/tool-a,server/tool-b"
NAVO_RATE_LIMIT_PER_MINUTE=120
pnpm --filter @runto/gateway start
```

Put TLS and request-size limits in the edge proxy. Keep the allowlist narrow;
the gateway will refuse a non-loopback bind without both an API key and a
non-empty exact tool allowlist.

## Graceful MCP ownership

Long-lived SDK users should use `createMCPGateway` so upstream processes close
with the host application:

```ts
import { createMCPGateway } from "@runto/mcp";

const handle = await createMCPGateway({ servers });
const runtime = createRuntime({ provider, tools: handle.tools });
process.once("SIGTERM", () => void handle.close());
```
