import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;

export const EVENT_TYPES = [
  "run.started",
  "run.completed",
  "model.started",
  "model.completed",
  "tool.registry.updated",
  "tool.search.completed",
  "tool.inspected",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "context.compiled",
  "result.compiled",
  "cache.hit",
  "cache.miss",
  "cache.rejected_stale",
  "cache.validation.completed",
  "tool.plan.inferred",
  "parallel_group.started",
  "parallel_group.completed",
  "speculation.started",
  "speculation.accepted",
  "speculation.rejected",
  "workflow.learned",
  "replay.diverged",
  "optimization.applied",
] as const;

export type RuntimeEventType = (typeof EVENT_TYPES)[number];
export type EventAssignment = "control" | "treatment" | "canary";

export type JsonSchema = {
  $schema?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  examples?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
};

const ErrorMetadataSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const RuntimeEventSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    type: z.enum(EVENT_TYPES),
    timestamp: z.string().datetime({ offset: true }),
    projectId: z.string().optional(),
    environment: z.string().optional(),
    runId: z.string().optional(),
    traceId: z.string().optional(),
    parentSpanId: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    tool: z.string().optional(),
    inputSize: z.number().nonnegative().optional(),
    outputSize: z.number().nonnegative().optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cachedTokens: z.number().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    optimizationFlags: z.record(z.string(), z.boolean()),
    assignment: z.enum(["control", "treatment", "canary"]).optional(),
    success: z.boolean().optional(),
    error: ErrorMetadataSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
export type RuntimeEventInput = Partial<
  Omit<RuntimeEvent, "protocolVersion" | "id" | "timestamp" | "type">
>;

export function createRuntimeEvent(
  type: RuntimeEventType,
  input: RuntimeEventInput = {},
): RuntimeEvent {
  return RuntimeEventSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    optimizationFlags: {},
    payload: {},
    ...input,
  });
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  return RuntimeEventSchema.parse(value);
}

export function runtimeEventJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["protocolVersion", "id", "type", "timestamp", "optimizationFlags", "payload"],
    properties: {
      protocolVersion: { const: PROTOCOL_VERSION },
      id: { type: "string", format: "uuid" },
      type: { enum: [...EVENT_TYPES] },
      timestamp: { type: "string", format: "date-time" },
      projectId: { type: "string" },
      environment: { type: "string" },
      runId: { type: "string" },
      traceId: { type: "string" },
      parentSpanId: { type: "string" },
      durationMs: { type: "number", minimum: 0 },
      provider: { type: "string" },
      model: { type: "string" },
      tool: { type: "string" },
      inputSize: { type: "number", minimum: 0 },
      outputSize: { type: "number", minimum: 0 },
      inputTokens: { type: "number", minimum: 0 },
      outputTokens: { type: "number", minimum: 0 },
      cachedTokens: { type: "number", minimum: 0 },
      estimatedCostUsd: { type: "number", minimum: 0 },
      optimizationFlags: { type: "object", additionalProperties: { type: "boolean" } },
      assignment: { enum: ["control", "treatment", "canary"] },
      success: { type: "boolean" },
      error: {
        type: "object",
        required: ["name", "message"],
        properties: {
          name: { type: "string" },
          message: { type: "string" },
          code: { type: "string" },
          details: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
      payload: { type: "object", additionalProperties: true },
    },
    additionalProperties: false,
  };
}
