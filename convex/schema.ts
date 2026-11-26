import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  runtimeEvents: defineTable({
    protocolVersion: v.string(),
    eventId: v.string(),
    type: v.string(),
    timestamp: v.string(),
    projectId: v.optional(v.string()),
    environment: v.optional(v.string()),
    runId: v.optional(v.string()),
    traceId: v.optional(v.string()),
    parentSpanId: v.optional(v.string()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    tool: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    inputSize: v.optional(v.number()),
    outputSize: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedTokens: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.number()),
    assignment: v.optional(v.string()),
    success: v.optional(v.boolean()),
    error: v.optional(v.any()),
    optimizationFlags: v.any(),
    payload: v.any(),
  })
    .index("by_event_id", ["eventId"])
    .index("by_project_timestamp", ["projectId", "timestamp"])
    .index("by_timestamp", ["timestamp"])
    .index("by_run", ["runId", "timestamp"]),
});
