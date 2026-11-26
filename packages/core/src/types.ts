import type { CacheAdapter, CachePolicy } from "@runto/cache";
import type { ContextCompileInput, ContextCompiler, ContextItem } from "@runto/context";
import type { JsonSchema } from "@runto/protocol";
import type { DependencyScheduler } from "@runto/scheduler";
import type { Telemetry, TelemetryExporter } from "@runto/telemetry";

export type { CachePolicy } from "@runto/cache";
export type { JsonSchema } from "@runto/protocol";

export type SideEffect = "none" | "read" | "write" | "irreversible";

export interface ToolMetadata {
  server?: string;
  sideEffect: SideEffect;
  idempotent: boolean;
  cachePolicy?: CachePolicy;
  examples?: unknown[];
  historicalCooccurrence?: Record<string, number>;
  cacheValidator?: (
    value: unknown,
    input: unknown,
    context: ToolContext,
  ) => boolean | Promise<boolean>;
}

export interface ToolContext {
  runId: string;
  traceId: string;
  signal: AbortSignal;
  metadata: Record<string, unknown>;
}

export interface RuntimeTool<Input = unknown, Output = unknown> {
  id: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  metadata: ToolMetadata;
  execute(input: Input, context: ToolContext): Promise<Output>;
}

export interface ToolSummary {
  id: string;
  name: string;
  description: string;
  server?: string;
  sideEffect: SideEffect;
  score?: number;
}

export interface ToolRegistry {
  list(): RuntimeTool[];
  get(id: string): RuntimeTool | undefined;
  add(tool: RuntimeTool): void;
  search(query: string, options?: { strategy?: DiscoveryStrategy; topK?: number }): ToolSummary[];
  searchAsync(
    query: string,
    options?: { strategy?: DiscoveryStrategy; topK?: number },
  ): Promise<ToolSummary[]>;
}

export type DiscoveryStrategy = "keyword" | "bm25" | "embedding" | "hybrid" | "learned";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface LearnedToolRanker {
  rank(query: string, tools: RuntimeTool[]): Promise<Array<{ toolId: string; score: number }>>;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ProviderToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  toolId: string;
  arguments: unknown;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  instructions?: string;
  /** Optional provider-native cap for this individual generation. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: ProviderUsage;
  finishReason?: string;
  reasoning?: unknown;
  raw?: unknown;
}

export interface Provider {
  name: string;
  model: string;
  costPerMillionTokens?: { input: number; output: number; cachedInput?: number };
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "reasoning"; data: unknown }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "finish"; reason?: string };

export interface OptimizationConfig {
  toolDiscovery?: boolean | { enabled?: boolean; strategy?: DiscoveryStrategy; topK?: number };
  schemaCompiler?: boolean | { enabled?: boolean };
  contextCompiler?: boolean | { enabled?: boolean; tokenBudget?: number };
  resultCompiler?:
    | boolean
    | {
        enabled?: boolean;
        maxInlineBytes?: number;
        maxPreviewBytes?: number;
        conciseResponse?: boolean;
      };
  cache?:
    | boolean
    | {
        enabled?: boolean;
        adapter?: "memory" | "filesystem" | "sqlite" | "redis";
        cache?: CacheAdapter;
      };
  parallelExecution?:
    | boolean
    | {
        enabled?: boolean;
        maxConcurrency?: number;
        timeoutMs?: number;
        retries?: number;
        promptGuidance?: boolean;
        /** Cap the tool-planning response without limiting final synthesis. */
        planningOutputTokens?: number;
      };
  speculation?:
    | boolean
    | { enabled?: boolean; mode?: "read-only"; minConfidence?: number; maxCostUsd?: number };
}

export interface RuntimePolicy {
  maxSteps?: number;
  maxToolCalls?: number;
  maxOutputBytes?: number;
  allowedTools?: string[];
  denySideEffects?: SideEffect[];
}

export interface RuntimeOptions {
  provider: Provider;
  tools?: RuntimeTool[];
  /** Hard deadline for a run unless overridden by RunRequest.timeoutMs. */
  timeoutMs?: number;
  telemetry?:
    | Telemetry
    | {
        enabled?: boolean;
        exporter?: "memory" | "jsonl" | "otel" | "convex" | TelemetryExporter | TelemetryExporter[];
        path?: string;
        convexUrl?: string;
        convexApiKey?: string;
        captureContent?: boolean;
        failOnExporterError?: boolean;
        exporterTimeoutMs?: number;
        convexTimeoutMs?: number;
        onExporterError?: (error: unknown, exporter: TelemetryExporter) => void | Promise<void>;
      };
  optimizations?: OptimizationConfig;
  policy?: RuntimePolicy;
  resultHandleLimit?: number;
  projectId?: string;
  environment?: string;
  scheduler?: DependencyScheduler;
  dependencyResolver?: ToolDependencyResolver;
  embeddingProvider?: EmbeddingProvider;
  learnedToolRanker?: LearnedToolRanker;
  workflowMemory?: WorkflowMemory;
  contextCompiler?: ContextCompiler;
  cache?: CacheAdapter;
}

export type ToolDependencyResolver = (
  calls: ToolCall[],
  tools: ToolRegistry,
) => ReadonlyMap<string, string[]>;

export interface WorkflowMemory {
  record(task: string, toolIds: string[]): void | Promise<void>;
  suggest(task: string, limit?: number): string[] | Promise<string[]>;
}

export interface RunRequest {
  task: string;
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  assignment?: "control" | "treatment" | "canary";
  /** Explicit caller-supplied read-only fan-out; writes are rejected at runtime. */
  readOnlyPlan?: ReadOnlyToolPlan[];
  context?: ContextItem[];
  contextInput?: Omit<ContextCompileInput, "task" | "items">;
  speculationTrace?: HistoricalTraceStep[];
}

export interface HistoricalTraceStep {
  toolId: string;
  arguments: unknown;
  sideEffect: SideEffect;
  confidence: number;
  estimatedCostUsd?: number;
}

export interface ReadOnlyToolPlan {
  id: string;
  toolId: string;
  input: unknown;
  dependsOn?: string[];
}

export interface RuntimeMetrics {
  durationMs: number;
  modelDurationMs: number;
  toolDurationMs: number;
  modelCalls: number;
  toolCalls: number;
  parallelGroupCount: number;
  parallelToolCalls: number;
  cacheHits: number;
  cacheMisses: number;
  staleCacheRejections: number;
  cacheValidationCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  toolDefinitionTokens: number;
  inspectedTools: string[];
  executedTools: string[];
  invalidToolCalls: number;
  inferredDependencyCount: number;
  success: boolean;
  assignment: "control" | "treatment" | "canary";
}

export interface RuntimeResult {
  output: string;
  runId: string;
  traceId: string;
  metrics: RuntimeMetrics;
}

export interface Runtime {
  run(request: RunRequest): Promise<RuntimeResult>;
  getResult(handle: string): unknown;
  tools: ToolRegistry;
}
