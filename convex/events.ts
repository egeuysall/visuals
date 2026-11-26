import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

const eventArgs = v.object({
  protocolVersion: v.string(),
  id: v.string(),
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
});

export const ingest = internalMutation({
  args: { events: v.array(eventArgs) },
  handler: async (ctx, args) => {
    for (const event of args.events) {
      const duplicate = await ctx.db
        .query("runtimeEvents")
        .withIndex("by_event_id", (query) => query.eq("eventId", event.id))
        .first();
      if (duplicate) continue;
      await ctx.db.insert("runtimeEvents", {
        protocolVersion: event.protocolVersion,
        eventId: event.id,
        type: event.type,
        timestamp: event.timestamp,
        projectId: event.projectId,
        environment: event.environment,
        runId: event.runId,
        traceId: event.traceId,
        parentSpanId: event.parentSpanId,
        provider: event.provider,
        model: event.model,
        tool: event.tool,
        durationMs: event.durationMs,
        inputSize: event.inputSize,
        outputSize: event.outputSize,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedTokens: event.cachedTokens,
        estimatedCostUsd: event.estimatedCostUsd,
        assignment: event.assignment,
        success: event.success,
        error: event.error,
        optimizationFlags: event.optimizationFlags,
        payload: event.payload,
      });
    }
    return { accepted: args.events.length };
  },
});

export const recent = query({
  args: { projectId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(500, Math.max(1, args.limit ?? 100));
    const events = args.projectId
      ? await ctx.db
          .query("runtimeEvents")
          .withIndex("by_project_timestamp", (query) => query.eq("projectId", args.projectId))
          .order("desc")
          .take(limit)
      : await ctx.db.query("runtimeEvents").withIndex("by_timestamp").order("desc").take(limit);
    return events;
  },
});
