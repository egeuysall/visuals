import path from "node:path";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const root = path.join(__dirname, "../..");

export default function config(phase: string): NextConfig {
  // `next dev` gets the same bindings as production: a local D1 database and the real AI binding.
  // Only there: it signs in to Cloudflare, which builds and CI must not need.
  if (phase === PHASE_DEVELOPMENT_SERVER) initOpenNextCloudflareForDev();
  return { turbopack: { root }, outputFileTracingRoot: root };
}
