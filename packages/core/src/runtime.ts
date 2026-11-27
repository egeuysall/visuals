import { createHash, randomUUID } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import {
  type CacheAdapter,
  type CacheEntry,
  FileCacheAdapter,
  MemoryCacheAdapter,
  SqliteCacheAdapter,
} from "@runto/cache";
import { type ContextCompiler, DeterministicContextCompiler, estimateTokens } from "@runto/context";
import type { JsonSchema } from "@runto/protocol";
import { createScheduler, type DependencyScheduler, type ToolPlanNode } from "@runto/scheduler";
import { createTelemetry, Telemetry } from "@runto/telemetry";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createToolRegistry, type InMemoryToolRegistry } from "./discovery.js";
import { inferToolDependencies, resolveToolCallArguments } from "./planner.js";
import { type CompiledToolResult, MemoryResultCompiler, type ResultCompiler } from "./result.js";
import { compileToolSchema } from "./schema.js";
import { ReadOnlySpeculationController } from "./speculation.js";
import type {
  DiscoveryStrategy,
  OptimizationConfig,
  Provider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderToolDefinition,
  ReadOnlyToolPlan,
  RunRequest,
  Runtime,
  RuntimeMetrics,
  RuntimeOptions,
  RuntimeResult,
  RuntimeTool,
  SideEffect,
  ToolCall,
  ToolContext,
} from "./types.js";

const DISCOVERY_TOOLS: ProviderToolDefinition[] = [
  {
    id: "search_tools",
    name: "search_tools",
    description:
      "Find relevant tools by keyword or natural-language task. Inspect a result before executing it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        topK: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    id: "inspect_tool",
    name: "inspect_tool",
    description: "Inspect one discovered tool and its exact validated input schema.",
    inputSchema: {
      type: "object",
      properties: { toolId: { type: "string", minLength: 1 } },
      required: ["toolId"],
      additionalProperties: false,
    },
  },
  {
    id: "execute_tool",
    name: "execute_tool",
    description:
      "Execute an inspected tool with validated arguments. Writes remain policy-controlled and are never speculative.",
    inputSchema: {
      type: "object",
      properties: { toolId: { type: "string", minLength: 1 }, arguments: {} },
      required: ["toolId", "arguments"],
      additionalProperties: false,
    },
  },
];

interface NormalizedOptimizations {
  toolDiscovery: { enabled: boolean; strategy: DiscoveryStrategy; topK: number };
  schemaCompiler: { enabled: boolean };
  contextCompiler: { enabled: boolean; tokenBudget: number };
  resultCompiler: {
    enabled: boolean;
    maxInlineBytes: number;
    maxPreviewBytes: number;
    conciseResponse: boolean;
  };
  cache: {
    enabled: boolean;
    adapter?: CacheAdapter;
    adapterName: "memory" | "filesystem" | "sqlite" | "redis";
  };
  parallelExecution: {
    enabled: boolean;
    maxConcurrency: number;
    timeoutMs?: number;
    retries: number;
    promptGuidance: boolean;
    planningOutputTokens?: number;
  };
  speculation: { enabled: boolean; mode: "read-only"; minConfidence: number; maxCostUsd: number };
}

interface ToolExecutionResult {
  value: unknown;
  compiled: CompiledToolResult;
  fromCache: boolean;
}

type TelemetryEventType = Parameters<Telemetry["emit"]>[0];
type TelemetryEventInput = Parameters<Telemetry["emit"]>[1];

type NormalizedPolicy = {
  maxSteps: number;
  maxToolCalls: number;
  maxOutputBytes: number;
  allowedTools?: string[];
  denySideEffects: SideEffect[];
};

function enabled(value: boolean | { enabled?: boolean } | undefined): boolean {
  return typeof value === "boolean" ? value : (value?.enabled ?? false);
}

function normalizeOptimizations(config: OptimizationConfig = {}): NormalizedOptimizations {
  return {
    toolDiscovery: {
      enabled: enabled(config.toolDiscovery),
      strategy:
        typeof config.toolDiscovery === "object"
          ? (config.toolDiscovery.strategy ?? "bm25")
          : "bm25",
      topK: typeof config.toolDiscovery === "object" ? (config.toolDiscovery.topK ?? 5) : 5,
    },
    schemaCompiler: { enabled: enabled(config.schemaCompiler) },
    contextCompiler: {
      enabled: enabled(config.contextCompiler),
      tokenBudget:
        typeof config.contextCompiler === "object"
          ? (config.contextCompiler.tokenBudget ?? 8_000)
          : 8_000,
    },
    resultCompiler: {
      enabled: enabled(config.resultCompiler),
      maxInlineBytes:
        typeof config.resultCompiler === "object"
          ? (config.resultCompiler.maxInlineBytes ?? 20_000)
          : 20_000,
      maxPreviewBytes:
        typeof config.resultCompiler === "object"
          ? (config.resultCompiler.maxPreviewBytes ?? 2_000)
          : 2_000,
      conciseResponse:
        typeof config.resultCompiler === "object"
          ? (config.resultCompiler.conciseResponse ?? true)
          : true,
    },
    cache: {
      enabled: enabled(config.cache),
      adapter: typeof config.cache === "object" ? config.cache.cache : undefined,
      adapterName: typeof config.cache === "object" ? (config.cache.adapter ?? "memory") : "memory",
    },
    parallelExecution: {
      enabled: enabled(config.parallelExecution),
      maxConcurrency:
        typeof config.parallelExecution === "object"
          ? (config.parallelExecution.maxConcurrency ?? 4)
          : 4,
      timeoutMs:
        typeof config.parallelExecution === "object"
          ? config.parallelExecution.timeoutMs
          : undefined,
      retries:
        typeof config.parallelExecution === "object" ? (config.parallelExecution.retries ?? 0) : 0,
      promptGuidance:
        typeof config.parallelExecution === "object"
          ? (config.parallelExecution.promptGuidance ?? true)
          : true,
      planningOutputTokens:
        typeof config.parallelExecution === "object" &&
        config.parallelExecution.planningOutputTokens !== undefined
          ? Math.max(256, Math.floor(config.parallelExecution.planningOutputTokens))
          : undefined,
    },
    speculation: {
      enabled: enabled(config.speculation),
      mode: "read-only",
      minConfidence:
        typeof config.speculation === "object" ? (config.speculation.minConfidence ?? 0.8) : 0.8,
      maxCostUsd: typeof config.speculation === "object" ? (config.speculation.maxCostUsd ?? 0) : 0,
    },
  };
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cacheKey(toolId: string, input: unknown): string {
  return `tool:${createHash("sha256")
    .update(`${toolId}:${stable(input)}`)
    .digest("hex")}`;
}

function abortError(message = "Operation aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

function createRunSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  if (timeoutMs > 0)
    timer = setTimeout(
      () => controller.abort(abortError(`Run timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function raceAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  operation.catch(() => undefined);
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function getPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

type JsonValidator = ((value: unknown) => boolean) & {
  errors?: Array<{
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  }>;
};

const jsonValidator = new Ajv2020({ allErrors: false, strict: false });
const legacyJsonValidator = new Ajv({ allErrors: false, strict: false });
const validatorCache = new Map<string, JsonValidator>();

/**
 * Ajv writes validators as source code and evaluates it. Runtimes that forbid that, such as
 * Cloudflare Workers, get an interpreter with the same answer.
 */
function compileSchema(engine: Ajv | Ajv2020, schema: JsonSchema): JsonValidator {
  try {
    return engine.compile(schema as never) as JsonValidator;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        /code generation|EvalError|unsafe-eval/i.test(`${error.name} ${error.message}`)
      )
    )
      throw error;
    return interpretedValidator(schema);
  }
}

export function interpretedValidator(schema: JsonSchema): JsonValidator {
  const draft =
    typeof schema.$schema === "string" && schema.$schema.includes("2020-12") ? "2020-12" : "7";
  const interpreter = new Validator(schema as never, draft);
  const validate: JsonValidator = (value: unknown) => {
    const result = interpreter.validate(value);
    validate.errors = result.errors.slice(-1).map((e) => ({
      instancePath: e.instanceLocation.replace(/^#/, ""),
      keyword: e.keyword,
      message: e.error,
    }));
    return result.valid;
  };
  return validate;
}

export function validateToolInput(
  value: unknown,
  schema: JsonSchema,
  path = "input",
): string | undefined {
  const key = stable(schema);
  let validator = validatorCache.get(key);
  if (!validator) {
    try {
      const engine =
        typeof schema.$schema === "string" && schema.$schema.includes("2020-12")
          ? jsonValidator
          : legacyJsonValidator;
      validator = compileSchema(engine, schema);
      validatorCache.set(key, validator);
    } catch (error) {
      return `${path} has an invalid schema: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (validator(value)) return undefined;
  const error = validator.errors?.[0];
  const missing =
    typeof error?.params?.missingProperty === "string" ? `.${error.params.missingProperty}` : "";
  const instancePath = (error?.instancePath ?? "").replaceAll("/", ".");
  return `${path}${instancePath}${missing} ${error?.message ?? "is invalid"}`;
}

function normalizeToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export class NavoRuntime implements Runtime {
  readonly tools: InMemoryToolRegistry;
  private readonly provider: Provider;
  private readonly telemetry: Telemetry;
  private readonly options: RuntimeOptions;
  private readonly optimizations: NormalizedOptimizations;
  private readonly policy: NormalizedPolicy;
  private readonly scheduler: DependencyScheduler;
  private readonly contextCompiler: ContextCompiler;
  private readonly cache: CacheAdapter;
  private readonly resultCompiler: ResultCompiler;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.provider = options.provider;
    this.tools = createToolRegistry(options.tools ?? [], {
      embeddingProvider: options.embeddingProvider,
      learnedToolRanker: options.learnedToolRanker,
    });
    this.optimizations = normalizeOptimizations(options.optimizations);
    this.policy = {
      maxSteps: options.policy?.maxSteps ?? 8,
      maxToolCalls: options.policy?.maxToolCalls ?? 32,
      maxOutputBytes: options.policy?.maxOutputBytes ?? 100_000,
      allowedTools: options.policy?.allowedTools,
      denySideEffects: options.policy?.denySideEffects ?? [],
    };
    this.scheduler = options.scheduler ?? createScheduler();
    this.contextCompiler = options.contextCompiler ?? new DeterministicContextCompiler();
    if (options.cache) this.cache = options.cache;
    else if (this.optimizations.cache.adapter) this.cache = this.optimizations.cache.adapter;
    else if (this.optimizations.cache.adapterName === "filesystem")
      this.cache = new FileCacheAdapter();
    else if (this.optimizations.cache.adapterName === "sqlite")
      this.cache = new SqliteCacheAdapter();
    else if (this.optimizations.cache.adapterName === "redis")
      throw new Error(
        "Pass a RedisCacheAdapter through optimizations.cache.cache or RuntimeOptions.cache",
      );
    else this.cache = new MemoryCacheAdapter();
    this.resultCompiler = new MemoryResultCompiler(
      this.optimizations.resultCompiler.maxInlineBytes,
      options.resultHandleLimit,
      this.optimizations.resultCompiler.maxPreviewBytes,
    );
    this.telemetry =
      options.telemetry instanceof Telemetry
        ? options.telemetry
        : createTelemetry(options.telemetry ?? {});
  }

  getResult(handle: string): unknown {
    return this.resultCompiler.get(handle);
  }

  private optimizationFlags(): Record<string, boolean> {
    return Object.fromEntries(
      Object.entries(this.optimizations).map(([key, value]) => [key, value.enabled]),
    );
  }

  private eventBase(runId: string, traceId: string, assignment: RuntimeMetrics["assignment"]) {
    return {
      projectId: this.options.projectId,
      environment: this.options.environment,
      runId,
      traceId,
      provider: this.provider.name,
      model: this.provider.model,
      assignment,
      optimizationFlags: this.optimizationFlags(),
    };
  }

  private emitTelemetry(
    type: TelemetryEventType,
    input: TelemetryEventInput,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Telemetry["emit"]>>> {
    const operation = this.telemetry.emit(type, input);
    return signal ? raceAbortable(operation, signal) : operation;
  }

  private flushTelemetry(signal?: AbortSignal): Promise<void> {
    const operation = this.telemetry.flush();
    return signal ? raceAbortable(operation, signal) : operation;
  }

  private visibleTools(): RuntimeTool[] {
    return this.tools
      .list()
      .filter(
        (tool) =>
          (!this.policy.allowedTools || this.policy.allowedTools.includes(tool.id)) &&
          !this.policy.denySideEffects.includes(tool.metadata.sideEffect),
      );
  }

  private policyAllows(tool: RuntimeTool | undefined): tool is RuntimeTool {
    return Boolean(tool && this.visibleTools().some((candidate) => candidate.id === tool.id));
  }

  private toolDefinitions(tools: RuntimeTool[]): {
    definitions: ProviderToolDefinition[];
    tokens: number;
  } {
    let tokens = 0;
    const definitions = tools.map((tool) => {
      const schema = this.optimizations.schemaCompiler.enabled
        ? compileToolSchema(tool.inputSchema)
        : { compact: tool.inputSchema, beforeTokens: 0, afterTokens: 0 };
      tokens += this.optimizations.schemaCompiler.enabled
        ? schema.afterTokens
        : estimateTokens(serialized(tool.inputSchema));
      return {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        inputSchema: schema.compact,
      };
    });
    return { definitions, tokens };
  }

  private async executeTool(
    call: ToolCall,
    context: ToolContext,
    metrics: RuntimeMetrics,
    assignment: RuntimeMetrics["assignment"],
    throwOnError = false,
  ): Promise<ToolExecutionResult> {
    if (context.signal.aborted) throw new DOMException("Tool call aborted", "AbortError");
    const emitTelemetry = (type: TelemetryEventType, input: TelemetryEventInput) =>
      this.emitTelemetry(type, input, context.signal);
    const toolId = call.toolId;
    const metaDefinition = DISCOVERY_TOOLS.find((tool) => tool.id === toolId);
    if (metaDefinition) {
      const inputError = validateToolInput(
        normalizeToolArguments(call.arguments),
        metaDefinition.inputSchema,
      );
      if (inputError) {
        metrics.invalidToolCalls += 1;
        await emitTelemetry("tool.failed", {
          ...this.eventBase(context.runId, context.traceId, assignment),
          tool: toolId,
          success: false,
          error: { name: "ValidationError", message: inputError },
        });
        return {
          value: { error: inputError },
          compiled: this.resultCompiler.compile({ error: inputError }),
          fromCache: false,
        };
      }
    }
    if (this.optimizations.toolDiscovery.enabled && toolId === "search_tools") {
      const input = normalizeToolArguments(call.arguments) as { query?: string; topK?: number };
      const query = typeof input?.query === "string" ? input.query : "";
      const allowed = new Set(this.visibleTools().map((tool) => tool.id));
      const matches = (
        await this.tools.searchAsync(query, {
          strategy: this.optimizations.toolDiscovery.strategy,
          topK: Math.max(input.topK ?? this.optimizations.toolDiscovery.topK, allowed.size),
        })
      )
        .filter((match) => allowed.has(match.id))
        .slice(0, input.topK ?? this.optimizations.toolDiscovery.topK);
      await emitTelemetry("tool.search.completed", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: toolId,
        success: true,
        payload: { query, matches },
      });
      return {
        value: matches,
        compiled: this.resultCompiler.compile(matches, {
          maxInlineBytes: 20_000,
          provenance: "tool-registry",
        }),
        fromCache: false,
      };
    }
    if (this.optimizations.toolDiscovery.enabled && toolId === "inspect_tool") {
      const input = normalizeToolArguments(call.arguments) as { toolId?: string };
      const tool = typeof input?.toolId === "string" ? this.tools.get(input.toolId) : undefined;
      if (!tool)
        return {
          value: { error: "Unknown tool" },
          compiled: this.resultCompiler.compile({ error: "Unknown tool" }),
          fromCache: false,
        };
      if (!this.policyAllows(tool)) {
        return {
          value: { error: "Tool is not allowed by runtime policy" },
          compiled: this.resultCompiler.compile({ error: "Tool is not allowed by runtime policy" }),
          fromCache: false,
        };
      }
      metrics.inspectedTools.push(tool.id);
      await emitTelemetry("tool.inspected", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: tool.id,
        success: true,
        payload: { metadata: tool.metadata, inputSchema: tool.inputSchema },
      });
      return {
        value: {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          metadata: tool.metadata,
        },
        compiled: this.resultCompiler.compile(
          {
            id: tool.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            metadata: tool.metadata,
          },
          { provenance: `tool://${tool.id}` },
        ),
        fromCache: false,
      };
    }

    let actualToolId = toolId;
    let actualInput = normalizeToolArguments(call.arguments);
    if (this.optimizations.toolDiscovery.enabled && toolId === "execute_tool") {
      const input = normalizeToolArguments(call.arguments) as {
        toolId?: string;
        arguments?: unknown;
      };
      actualToolId = typeof input?.toolId === "string" ? input.toolId : "";
      actualInput = input?.arguments;
    }
    const tool = this.tools.get(actualToolId);
    if (!tool) {
      metrics.invalidToolCalls += 1;
      return {
        value: { error: `Unknown tool: ${actualToolId}` },
        compiled: this.resultCompiler.compile({ error: `Unknown tool: ${actualToolId}` }),
        fromCache: false,
      };
    }
    if (this.policy.allowedTools && !this.policy.allowedTools.includes(tool.id)) {
      return {
        value: { error: "Tool is not allowed by runtime policy" },
        compiled: this.resultCompiler.compile({ error: "Tool is not allowed by runtime policy" }),
        fromCache: false,
      };
    }
    if (this.policy.denySideEffects.includes(tool.metadata.sideEffect)) {
      return {
        value: { error: `Side effect ${tool.metadata.sideEffect} is denied by runtime policy` },
        compiled: this.resultCompiler.compile({ error: "Side effect denied" }),
        fromCache: false,
      };
    }
    const inputError = validateToolInput(actualInput, tool.inputSchema);
    if (inputError) {
      metrics.invalidToolCalls += 1;
      await emitTelemetry("tool.failed", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: tool.id,
        success: false,
        error: { name: "ValidationError", message: inputError },
      });
      return {
        value: { error: inputError },
        compiled: this.resultCompiler.compile({ error: inputError }),
        fromCache: false,
      };
    }

    const policy = tool.metadata.cachePolicy;
    const key = cacheKey(tool.id, actualInput);
    if (this.optimizations.cache.enabled && policy && policy.mode !== "never") {
      const entry = await this.cache.get(key);
      if (entry) {
        const expired = entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
        const versionMismatch =
          policy.mode === "versioned" &&
          entry.version !== String(getPath(actualInput, policy.versionField));
        let valid = !expired && !versionMismatch;
        if (valid && policy.mode === "validate-before-use") {
          metrics.cacheValidationCalls += 1;
          let validation = false;
          try {
            validation = Boolean(
              await tool.metadata.cacheValidator?.(entry.value, actualInput, context),
            );
          } catch {
            validation = false;
          }
          await emitTelemetry("cache.validation.completed", {
            ...this.eventBase(context.runId, context.traceId, assignment),
            tool: tool.id,
            success: validation,
            payload: { key, valid: validation },
          });
          valid = validation;
        }
        if (valid) {
          metrics.cacheHits += 1;
          const compiled = this.resultCompiler.compile(entry.value, {
            maxInlineBytes: this.optimizations.resultCompiler.maxInlineBytes,
            provenance: `cache://${key}`,
          });
          await emitTelemetry("cache.hit", {
            ...this.eventBase(context.runId, context.traceId, assignment),
            tool: tool.id,
            success: true,
            payload: { key, validated: policy.mode === "validate-before-use" },
          });
          await emitTelemetry("result.compiled", {
            ...this.eventBase(context.runId, context.traceId, assignment),
            tool: tool.id,
            outputSize: compiled.sizeBytes,
            success: true,
            payload: {
              inline: compiled.inline,
              handle: compiled.handle,
              provenance: compiled.provenance,
            },
          });
          return { value: entry.value, compiled, fromCache: true };
        }
        metrics.staleCacheRejections += 1;
        await emitTelemetry("cache.rejected_stale", {
          ...this.eventBase(context.runId, context.traceId, assignment),
          tool: tool.id,
          success: false,
          payload: {
            key,
            expired,
            versionMismatch,
            validationRequired: policy.mode === "validate-before-use",
          },
        });
        await this.cache.delete?.(key);
      }
      metrics.cacheMisses += 1;
      await emitTelemetry("cache.miss", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: tool.id,
        success: true,
        payload: { key },
      });
    }

    const started = Date.now();
    metrics.executedTools.push(tool.id);
    await emitTelemetry("tool.started", {
      ...this.eventBase(context.runId, context.traceId, assignment),
      tool: tool.id,
      inputSize: serialized(actualInput).length,
      payload: { sideEffect: tool.metadata.sideEffect },
    });
    try {
      const value = await tool.execute(actualInput, context);
      if (context.signal.aborted) throw new DOMException("Tool call aborted", "AbortError");
      const compiled = this.optimizations.resultCompiler.enabled
        ? this.resultCompiler.compile(value, {
            maxInlineBytes: this.optimizations.resultCompiler.maxInlineBytes,
            provenance: `tool://${tool.id}`,
          })
        : this.resultCompiler.compile(value, {
            maxInlineBytes: this.policy.maxOutputBytes,
            provenance: `tool://${tool.id}`,
          });
      await emitTelemetry("result.compiled", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: tool.id,
        outputSize: compiled.sizeBytes,
        success: true,
        payload: {
          inline: compiled.inline,
          handle: compiled.handle,
          provenance: compiled.provenance,
        },
      });
      const entry: CacheEntry = {
        value,
        createdAt: Date.now(),
        ...(policy?.mode === "ttl" ? { expiresAt: Date.now() + policy.ttlMs } : {}),
        ...(policy?.mode === "versioned"
          ? { version: String(getPath(actualInput, policy.versionField)) }
          : {}),
      };
      if (this.optimizations.cache.enabled && policy && policy.mode !== "never")
        await this.cache.set(key, entry);
      await emitTelemetry("tool.completed", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: tool.id,
        durationMs: Date.now() - started,
        inputSize: serialized(actualInput).length,
        outputSize: compiled.sizeBytes,
        success: true,
        payload: { cached: false, handle: compiled.handle },
      });
      return { value, compiled, fromCache: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emitTelemetry("tool.failed", {
        ...this.eventBase(context.runId, context.traceId, assignment),
        tool: tool.id,
        durationMs: Date.now() - started,
        success: false,
        error: { name: error instanceof Error ? error.name : "ToolError", message },
      });
      if (context.signal.aborted || throwOnError) throw error;
      return {
        value: { error: message },
        compiled: this.resultCompiler.compile({ error: message }),
        fromCache: false,
      };
    }
  }

  private canRunTogether(left: ToolPlanNode, right: ToolPlanNode): boolean {
    const unsafe = new Set(["write", "irreversible"]);
    return !unsafe.has(left.sideEffect ?? "none") && !unsafe.has(right.sideEffect ?? "none");
  }

  async run(request: RunRequest): Promise<RuntimeResult> {
    const runId = randomUUID();
    const traceId = randomUUID();
    const assignment =
      request.assignment ??
      (Object.values(this.optimizations).some((value) => value.enabled) ? "treatment" : "control");
    const metrics: RuntimeMetrics = {
      durationMs: 0,
      modelDurationMs: 0,
      toolDurationMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      parallelGroupCount: 0,
      parallelToolCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      staleCacheRejections: 0,
      cacheValidationCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      estimatedCostUsd: 0,
      toolDefinitionTokens: 0,
      inspectedTools: [],
      executedTools: [],
      invalidToolCalls: 0,
      inferredDependencyCount: 0,
      success: false,
      assignment,
    };
    const started = Date.now();
    const base = this.eventBase(runId, traceId, assignment);
    const speculativeValues = new Map<string, unknown>();
    const runScope = createRunSignal(
      request.signal,
      Math.max(0, request.timeoutMs ?? this.options.timeoutMs ?? 120_000),
    );
    const runSignal = runScope.signal;
    const emitTelemetry = (type: TelemetryEventType, input: TelemetryEventInput) =>
      this.emitTelemetry(type, input, runSignal);
    const flushTelemetry = () => this.flushTelemetry(runSignal);
    try {
      await emitTelemetry("run.started", { ...base, payload: { task: request.task } });
      await emitTelemetry("tool.registry.updated", {
        ...base,
        success: true,
        payload: {
          count: this.visibleTools().length,
          tools: this.visibleTools().map((tool) => ({ id: tool.id, server: tool.metadata.server })),
        },
      });
      for (const [module, config] of Object.entries(this.optimizations)) {
        if (config.enabled)
          await emitTelemetry("optimization.applied", {
            ...base,
            success: true,
            payload: { module },
          });
      }
      if (this.optimizations.speculation.enabled) {
        await emitTelemetry("speculation.started", {
          ...base,
          success: true,
          payload: {
            mode: "read-only",
            status: request.speculationTrace?.length ? "running" : "rejected",
          },
        });
        if (!request.speculationTrace?.length) {
          await emitTelemetry("speculation.rejected", {
            ...base,
            success: true,
            payload: {
              reason: "No historical trace supplied; speculation is opt-in and read-only.",
            },
          });
        } else {
          const controller = new ReadOnlySpeculationController({
            minConfidence: this.optimizations.speculation.minConfidence,
            maxCostUsd: this.optimizations.speculation.maxCostUsd,
            maxConcurrency: this.optimizations.parallelExecution.maxConcurrency,
            allowedTools: this.policy.allowedTools,
            denySideEffects: this.policy.denySideEffects,
          });
          const results = await controller.simulate(
            request.speculationTrace,
            new Map(this.visibleTools().map((tool) => [tool.id, tool])),
            { runId, traceId, signal: runSignal },
          );
          for (const result of results) {
            if (result.reason === "awaiting-authoritative-match" && result.value !== undefined)
              speculativeValues.set(cacheKey(result.toolId, result.arguments), result.value);
            else if (!result.accepted)
              await emitTelemetry("speculation.rejected", {
                ...base,
                tool: result.toolId,
                success: true,
                payload: { reason: result.reason ?? "not-accepted" },
              });
          }
        }
      }
      const baseInstructions =
        [
          request.readOnlyPlan?.length
            ? "The runtime has already executed the supplied read-only plan. Synthesize the final answer from the returned tool results and do not repeat those calls."
            : undefined,
          this.optimizations.parallelExecution.enabled &&
          this.optimizations.parallelExecution.promptGuidance
            ? "When a task needs multiple independent read-only tools, request all of those tool calls in the same response so they can run concurrently. Do not wait for one independent source before requesting another. Preserve dependencies and always keep writes or irreversible operations serialized."
            : undefined,
          this.optimizations.resultCompiler.enabled &&
          this.optimizations.resultCompiler.conciseResponse
            ? "Keep the final answer concise: preserve requested sections and decision-critical facts, remove repetition, and avoid filler."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n\n") || undefined;
      const learnedTools = await this.options.workflowMemory?.suggest(request.task);
      const instructions =
        [
          baseInstructions,
          learnedTools?.length
            ? `A similar successful workflow used these tools: ${learnedTools.join(", ")}. Verify relevance before using them.`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n\n") || undefined;
      const messages: ProviderMessage[] = [{ role: "user", content: request.task }];
      if (request.context?.length) {
        const packet = this.optimizations.contextCompiler.enabled
          ? await this.contextCompiler.compile({
              task: request.task,
              items: request.context,
              tokenBudget:
                request.contextInput?.tokenBudget ?? this.optimizations.contextCompiler.tokenBudget,
              ...request.contextInput,
            })
          : {
              facts: request.context
                .filter((item) => item.authorized !== false)
                .map((item) => ({
                  text: item.text,
                  source: item.source,
                  confidence: item.confidence ?? 0.5,
                })),
              conflicts: [],
              excluded: [] as Array<{
                source: string;
                reason: "permission" | "stale" | "duplicate" | "low-relevance";
              }>,
              tokenCount: request.context.reduce((sum, item) => sum + estimateTokens(item.text), 0),
            };
        messages.unshift({
          role: "system",
          content: `Context packet:\n${packet.facts.map((fact) => `[${fact.source}] ${fact.text}`).join("\n")}`,
        });
        await emitTelemetry("context.compiled", {
          ...base,
          inputTokens: packet.tokenCount,
          outputTokens: packet.tokenCount,
          success: true,
          payload: { ...packet },
        });
      }

      let finalOutput = "";
      let completedByModel = false;
      let activeTools = this.optimizations.toolDiscovery.enabled
        ? [...DISCOVERY_TOOLS]
        : this.toolDefinitions(this.visibleTools()).definitions;
      const maxSteps = Math.min(request.maxSteps ?? this.policy.maxSteps, this.policy.maxSteps);
      let toolCallCount = 0;
      const executeCalls = async (
        calls: ToolCall[],
        step: number,
        plan?: ReadOnlyToolPlan[],
      ): Promise<ToolExecutionResult[]> => {
        if (plan) {
          if (plan.length !== calls.length) throw new Error("Read-only plan call count mismatch");
          for (const call of calls) {
            const tool = this.tools.get(call.toolId);
            if (!tool) throw new Error(`Unknown read-only plan tool: ${call.toolId}`);
            if (!["none", "read"].includes(tool.metadata.sideEffect))
              throw new Error(`Read-only plan rejected ${call.toolId}: write-capable tool`);
          }
        }
        const context: ToolContext = {
          runId,
          traceId,
          signal: runSignal,
          metadata: { assignment },
        };
        const completedValues = new Map<string, unknown>();
        const inferredDependencies = inferToolDependencies(
          calls,
          this.tools,
          this.options.dependencyResolver,
        );
        const inferredCount = [...inferredDependencies.values()].reduce(
          (sum, dependencies) => sum + dependencies.length,
          0,
        );
        metrics.inferredDependencyCount += inferredCount;
        if (inferredCount && !plan)
          await emitTelemetry("tool.plan.inferred", {
            ...base,
            success: true,
            payload: {
              step,
              dependencies: Object.fromEntries(inferredDependencies),
            },
          });
        const execute = async (
          call: ToolCall,
          signal: AbortSignal,
          throwOnError = false,
        ): Promise<ToolExecutionResult> => {
          metrics.toolCalls += 1;
          const resolvedCall = {
            ...call,
            arguments: resolveToolCallArguments(call.arguments, completedValues),
          };
          const normalizedCallArguments = normalizeToolArguments(resolvedCall.arguments);
          const speculationTarget =
            resolvedCall.toolId === "execute_tool" &&
            normalizedCallArguments &&
            typeof normalizedCallArguments === "object" &&
            typeof (normalizedCallArguments as { toolId?: unknown }).toolId === "string"
              ? {
                  toolId: (normalizedCallArguments as { toolId: string }).toolId,
                  arguments: (normalizedCallArguments as { arguments?: unknown }).arguments,
                }
              : { toolId: resolvedCall.toolId, arguments: normalizedCallArguments };
          const speculativeKey = cacheKey(speculationTarget.toolId, speculationTarget.arguments);
          if (speculativeValues.has(speculativeKey)) {
            const value = speculativeValues.get(speculativeKey);
            speculativeValues.delete(speculativeKey);
            const compiled = this.resultCompiler.compile(value, {
              maxInlineBytes: this.policy.maxOutputBytes,
              provenance: `speculation://${speculationTarget.toolId}`,
            });
            metrics.executedTools.push(speculationTarget.toolId);
            await emitTelemetry("speculation.accepted", {
              ...base,
              tool: speculationTarget.toolId,
              success: true,
              outputSize: compiled.sizeBytes,
              payload: { callId: call.id, authoritativeMatch: true, handle: compiled.handle },
            });
            await emitTelemetry("tool.completed", {
              ...base,
              tool: speculationTarget.toolId,
              outputSize: compiled.sizeBytes,
              success: true,
              payload: { cached: false, speculative: true, handle: compiled.handle },
            });
            const result = { value, compiled, fromCache: false };
            completedValues.set(call.id, value);
            return result;
          }
          const result = await this.executeTool(
            resolvedCall,
            { ...context, signal },
            metrics,
            assignment,
            throwOnError,
          );
          completedValues.set(call.id, result.value);
          return result;
        };
        const toolPhaseStarted = Date.now();
        let results: ToolExecutionResult[];
        if (this.optimizations.parallelExecution.enabled && calls.length > 1) {
          const nodeIds = new Map<string, string>();
          calls.forEach((call, index) => {
            const nodeId = `${step}:${index}:${call.id}`;
            nodeIds.set(call.id, nodeId);
            const planId = plan?.[index]?.id;
            if (planId) nodeIds.set(planId, nodeId);
          });
          const nodes: ToolPlanNode[] = calls.map((call, index) => {
            const planNode = plan?.[index];
            const input =
              call.toolId === "execute_tool"
                ? (normalizeToolArguments(call.arguments) as {
                    toolId?: string;
                    arguments?: unknown;
                  })
                : undefined;
            const target = input?.toolId ?? call.toolId;
            const dependencyIds = [
              ...(planNode?.dependsOn ?? []),
              ...(inferredDependencies.get(call.id) ?? []),
            ];
            const dependsOn = [...new Set(dependencyIds)].map((dependency) => {
              const nodeId = nodeIds.get(dependency);
              if (!nodeId) throw new Error(`Unknown tool dependency: ${dependency}`);
              return nodeId;
            });
            return {
              id: `${step}:${index}:${call.id}`,
              toolId: call.toolId,
              input: call.arguments,
              dependsOn,
              sideEffect: this.tools.get(target)?.metadata.sideEffect ?? "none",
            };
          });
          await emitTelemetry("parallel_group.started", {
            ...base,
            payload: {
              tools: nodes.map((node) => node.toolId),
              dependencies: nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn })),
              step,
            },
          });
          metrics.parallelGroupCount += 1;
          metrics.parallelToolCalls += calls.length;
          const parallelGroupStarted = Date.now();
          const callByNodeId = new Map(nodes.map((node, index) => [node.id, calls[index]]));
          const scheduled = await this.scheduler.run(
            nodes,
            async (node, signal) => {
              const call = callByNodeId.get(node.id);
              if (!call) throw new Error(`Unknown scheduled tool node: ${node.id}`);
              return execute(call, signal, true);
            },
            {
              maxConcurrency: this.optimizations.parallelExecution.maxConcurrency,
              timeoutMs: this.optimizations.parallelExecution.timeoutMs,
              retries: this.optimizations.parallelExecution.retries,
              signal: runSignal,
              canRunTogether: (left, right) => this.canRunTogether(left, right),
            },
          );
          results = scheduled.map((item) => item.value);
          await emitTelemetry("parallel_group.completed", {
            ...base,
            durationMs: Date.now() - parallelGroupStarted,
            success: true,
            payload: { count: results.length, step },
          });
        } else {
          results = [];
          for (const call of calls) results.push(await execute(call, context.signal));
        }
        metrics.toolDurationMs += Date.now() - toolPhaseStarted;
        return results;
      };
      const appendToolResults = (calls: ToolCall[], results: ToolExecutionResult[]): void => {
        results.forEach((result, index) => {
          const call = calls[index];
          if (!call) return;
          if (call.toolId === "inspect_tool") {
            const input = normalizeToolArguments(call.arguments) as { toolId?: string };
            const tool = input?.toolId ? this.tools.get(input.toolId) : undefined;
            if (
              this.policyAllows(tool) &&
              !activeTools.some((candidate) => candidate.id === tool.id)
            ) {
              const definition = this.toolDefinitions([tool]).definitions[0];
              if (definition) activeTools = [...activeTools, definition];
            }
          }
          messages.push({
            role: "tool",
            name: call.toolId,
            toolCallId: call.id,
            content: result.compiled.content,
          });
        });
      };
      if (request.readOnlyPlan?.length) {
        if (request.readOnlyPlan.length > this.policy.maxToolCalls)
          throw new Error(`Read-only plan exceeds tool call budget (${this.policy.maxToolCalls})`);
        const plannedCalls = request.readOnlyPlan.map((node) => ({
          id: node.id,
          toolId: node.toolId,
          arguments: normalizeToolArguments(node.input),
        }));
        toolCallCount += plannedCalls.length;
        const plannedResults = await executeCalls(plannedCalls, -1, request.readOnlyPlan);
        messages.push({ role: "assistant", content: "", toolCalls: plannedCalls });
        appendToolResults(plannedCalls, plannedResults);
      }
      for (let step = 0; step < maxSteps; step += 1) {
        if (runSignal.aborted) throw abortError("Run aborted");
        const definitions = activeTools.map((tool) => {
          const original = this.tools.get(tool.id);
          if (!original || !this.optimizations.schemaCompiler.enabled) return tool;
          return { ...tool, inputSchema: compileToolSchema(original.inputSchema).compact };
        });
        metrics.toolDefinitionTokens += definitions.reduce(
          (sum, tool) => sum + estimateTokens(serialized(tool.inputSchema)),
          0,
        );
        const modelStarted = Date.now();
        await emitTelemetry("model.started", {
          ...base,
          inputSize: serialized(messages).length,
          payload: { step, toolCount: definitions.length },
        });
        const providerRequest: ProviderRequest = {
          messages,
          tools: definitions,
          ...(instructions ? { instructions } : {}),
          ...(this.optimizations.parallelExecution.planningOutputTokens !== undefined &&
          definitions.length > 0 &&
          !messages.some((message) => message.role === "tool")
            ? { maxOutputTokens: this.optimizations.parallelExecution.planningOutputTokens }
            : {}),
          signal: runSignal,
        };
        const response: ProviderResponse = await raceAbortable(
          this.provider.generate(providerRequest),
          runSignal,
        );
        metrics.modelDurationMs += Date.now() - modelStarted;
        metrics.modelCalls += 1;
        metrics.inputTokens += response.usage?.inputTokens ?? 0;
        metrics.outputTokens += response.usage?.outputTokens ?? 0;
        metrics.cachedTokens += response.usage?.cachedTokens ?? 0;
        metrics.estimatedCostUsd += this.estimateCost(response.usage);
        await emitTelemetry("model.completed", {
          ...base,
          durationMs: Date.now() - modelStarted,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          cachedTokens: response.usage?.cachedTokens,
          estimatedCostUsd: this.estimateCost(response.usage),
          success: true,
          payload: { finishReason: response.finishReason, reasoning: response.reasoning },
        });
        const calls = (response.toolCalls ?? []).map((call) => ({
          ...call,
          arguments: normalizeToolArguments(call.arguments),
        }));
        messages.push({
          role: "assistant",
          content: response.text ?? "",
          ...(calls.length ? { toolCalls: calls } : {}),
        });
        if (!calls.length) {
          finalOutput = response.text ?? "";
          completedByModel = true;
          break;
        }
        if (toolCallCount + calls.length > this.policy.maxToolCalls)
          throw new Error(`Tool call budget exceeded (${this.policy.maxToolCalls})`);
        toolCallCount += calls.length;
        const results = await executeCalls(calls, step);
        appendToolResults(calls, results);
      }
      if (!completedByModel) throw new Error("Max steps reached before final model response");
      if (Buffer.byteLength(finalOutput, "utf8") > this.policy.maxOutputBytes)
        finalOutput = finalOutput.slice(0, this.policy.maxOutputBytes);
      metrics.success = true;
      metrics.durationMs = Date.now() - started;
      if (metrics.executedTools.length) {
        await this.options.workflowMemory?.record(request.task, metrics.executedTools);
        await emitTelemetry("workflow.learned", {
          ...base,
          success: true,
          payload: { toolIds: metrics.executedTools },
        });
      }
      await emitTelemetry("run.completed", {
        ...base,
        durationMs: metrics.durationMs,
        outputSize: Buffer.byteLength(finalOutput, "utf8"),
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cachedTokens: metrics.cachedTokens,
        estimatedCostUsd: metrics.estimatedCostUsd,
        success: true,
        payload: { output: finalOutput, metrics },
      });
      await flushTelemetry();
      return { output: finalOutput, runId, traceId, metrics };
    } catch (error) {
      metrics.durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error) Object.assign(error, { runtimeMetrics: metrics });
      if (!runSignal.aborted) {
        await emitTelemetry("run.completed", {
          ...base,
          durationMs: metrics.durationMs,
          success: false,
          error: { name: error instanceof Error ? error.name : "RuntimeError", message },
          payload: { metrics },
        }).catch(() => undefined);
        await flushTelemetry().catch(() => undefined);
      }
      throw error;
    } finally {
      runScope.dispose();
    }
  }

  private estimateCost(usage: ProviderResponse["usage"]): number {
    if (!usage || !this.provider.costPerMillionTokens) return 0;
    const prices = this.provider.costPerMillionTokens;
    return (
      ((usage.inputTokens ?? 0) / 1_000_000) * prices.input +
      ((usage.outputTokens ?? 0) / 1_000_000) * prices.output +
      ((usage.cachedTokens ?? 0) / 1_000_000) * (prices.cachedInput ?? prices.input)
    );
  }
}

export function createRuntime(options: RuntimeOptions): Runtime {
  return new NavoRuntime(options);
}

export function createMockProvider(
  handler: (
    request: ProviderRequest,
    callNumber: number,
  ) => ProviderResponse | Promise<ProviderResponse>,
  options: { model?: string; name?: string } = {},
): Provider {
  let callNumber = 0;
  return {
    name: options.name ?? "mock",
    model: options.model ?? "mock-model",
    async generate(request) {
      callNumber += 1;
      return handler(request, callNumber);
    },
  };
}

export function createEchoProvider(): Provider {
  return createMockProvider((request) => ({
    text: request.messages.at(-1)?.content ?? "",
    toolCalls: [],
  }));
}
