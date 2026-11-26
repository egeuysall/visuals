# Hosted event store

This directory is the optional hosted persistence path. It uses Convex's
managed database and CLI, as requested; it is not a raw Postgres wire adapter.

```bash
pnpm install
pnpm convex:dev
# or: pnpm convex:deploy
pnpm exec convex env set NAVO_CONVEX_INGEST_KEY "replace-me"
```

The Convex CLI must be configured first; codegen/deploy require a
`CONVEX_DEPLOYMENT` created by `pnpm convex:dev`.

Set `NAVO_CONVEX_URL` to the deployment's HTTP actions URL and use
`telemetry: { exporter: "convex", convexUrl: process.env.NAVO_CONVEX_URL, convexApiKey: process.env.NAVO_CONVEX_INGEST_KEY }`.
