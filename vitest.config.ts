import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@runto/cache": new URL("./packages/cache/dist/index.js", import.meta.url).pathname,
      "@runto/context": new URL("./packages/context/dist/index.js", import.meta.url).pathname,
      "@runto/protocol": new URL("./packages/protocol/dist/index.js", import.meta.url).pathname,
      "@runto/scheduler": new URL("./packages/scheduler/dist/index.js", import.meta.url).pathname,
      "@runto/telemetry": new URL("./packages/telemetry/dist/index.js", import.meta.url).pathname,
      "@runto/core": new URL("./packages/core/dist/index.js", import.meta.url).pathname,
      "@runto/benchmark": new URL("./packages/benchmark/dist/index.js", import.meta.url).pathname,
      "@runto/mcp": new URL("./packages/mcp/dist/index.js", import.meta.url).pathname,
      "@runto/adapter-vercel-ai": new URL(
        "./packages/adapter-vercel-ai/dist/index.js",
        import.meta.url,
      ).pathname,
      "@runto/provider-vercel": new URL("./packages/provider-vercel/dist/index.js", import.meta.url)
        .pathname,
      "@runto/provider-openai": new URL("./packages/provider-openai/dist/index.js", import.meta.url)
        .pathname,
      "@runto/provider-anthropic": new URL(
        "./packages/provider-anthropic/dist/index.js",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
