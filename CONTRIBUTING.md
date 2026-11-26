# Contributing

1. Install Node 22+ and pnpm 11+.
2. Run `pnpm install`.
3. Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
4. Keep changes small, typed, and independently toggleable.

Use `pnpm changeset` when a published package needs a release note and version bump.

Do not include credentials, production traces, or customer data in commits. Add
tests for protocol, authorization, validation, caching, and tool execution
changes. Pull requests should explain how success and latency were measured.
