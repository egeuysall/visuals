import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Tracer, trace } from "@opentelemetry/api";
import {
  createRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeEventType,
} from "@runto/protocol";

export interface TelemetryExporter {
  export(event: RuntimeEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export class MemoryTelemetryExporter implements TelemetryExporter {
  readonly events: RuntimeEvent[] = [];

  export(event: RuntimeEvent): void {
    this.events.push(event);
  }
}

export class JsonlTelemetryExporter implements TelemetryExporter {
  private readonly events: RuntimeEvent[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly batchSize = 32,
  ) {}

  export(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
    return this.events.length >= this.batchSize ? this.flush() : Promise.resolve();
  }

  flush(): Promise<void> {
    if (!this.events.length) return this.pending;
    const batch = this.events.splice(0, this.events.length);
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(
          this.path,
          `${batch.map((event) => JSON.stringify(event)).join("\n")}\n`,
          "utf8",
        );
      })
      .catch((error) => {
        this.events.unshift(...batch);
        throw error;
      });
    return this.pending;
  }
}

export interface ConvexTelemetryExporterOptions {
  url: string;
  apiKey?: string;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Sends the same versioned events to the optional hosted Convex deployment. */
export class ConvexTelemetryExporter implements TelemetryExporter {
  private readonly events: RuntimeEvent[] = [];
  private readonly batchSize: number;
  private readonly request: typeof globalThis.fetch;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConvexTelemetryExporterOptions) {
    this.batchSize = Math.max(1, options.batchSize ?? 100);
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  export(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
    return this.events.length >= this.batchSize ? this.flush() : Promise.resolve();
  }

  flush(): Promise<void> {
    if (!this.events.length) return this.pending;
    const batch = this.events.splice(0, this.events.length);
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        const response = await this.request(`${this.options.url.replace(/\/$/, "")}/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          body: JSON.stringify(batch),
          ...(this.options.timeoutMs !== 0
            ? { signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) }
            : {}),
        });
        if (!response.ok) throw new Error(`Convex telemetry ingest failed (${response.status})`);
      })
      .catch((error) => {
        this.events.unshift(...batch);
        throw error;
      });
    return this.pending;
  }
}

export class OpenTelemetryExporter implements TelemetryExporter {
  private readonly tracer: Tracer;

  constructor(name = "navo") {
    this.tracer = trace.getTracer(name);
  }

  export(event: RuntimeEvent): void {
    this.tracer.startActiveSpan(event.type, (span) => {
      span.setAttributes({
        "aar.event_type": event.type,
        "aar.protocol_version": event.protocolVersion,
        ...(event.projectId ? { "aar.project_id": event.projectId } : {}),
        ...(event.runId ? { "aar.run_id": event.runId } : {}),
        ...(event.traceId ? { "aar.trace_id": event.traceId } : {}),
        ...(event.tool ? { "aar.tool": event.tool } : {}),
        ...(event.provider ? { "gen_ai.system": event.provider } : {}),
        ...(event.model ? { "gen_ai.request.model": event.model } : {}),
        ...(event.inputTokens !== undefined
          ? { "gen_ai.usage.input_tokens": event.inputTokens }
          : {}),
        ...(event.outputTokens !== undefined
          ? { "gen_ai.usage.output_tokens": event.outputTokens }
          : {}),
      });
      span.addEvent(event.type, { "aar.event": JSON.stringify(event.payload) });
      if (event.success === false) span.recordException(event.error?.message ?? "runtime failure");
      span.end();
    });
  }
}

const secretKey =
  /(api[_-]?key|authorization|cookie|password|secret|access[_-]?token|refresh[_-]?token|bearer)/i;

export function redactTelemetryValue(value: unknown, depth = 0, captureContent = false): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") {
    if (captureContent) return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
    const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
    return `[redacted:${digest}:${Buffer.byteLength(value, "utf8")}]`;
  }
  if (Array.isArray(value))
    return value.map((item) => redactTelemetryValue(item, depth + 1, captureContent));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) ? "[redacted]" : redactTelemetryValue(item, depth + 1, captureContent),
      ]),
    );
  }
  return value;
}

export class Telemetry {
  readonly exporters: TelemetryExporter[];
  private readonly captureContent: boolean;
  private readonly failOnExporterError: boolean;
  private readonly exporterTimeoutMs: number;
  private readonly onExporterError?: (
    error: unknown,
    exporter: TelemetryExporter,
  ) => void | Promise<void>;
  private lastExporterError: unknown;

  constructor(
    exporters: TelemetryExporter[] = [],
    options: {
      captureContent?: boolean;
      failOnExporterError?: boolean;
      exporterTimeoutMs?: number;
      onExporterError?: (error: unknown, exporter: TelemetryExporter) => void | Promise<void>;
    } = {},
  ) {
    this.exporters = exporters;
    this.captureContent = options.captureContent ?? false;
    this.failOnExporterError = options.failOnExporterError ?? false;
    this.exporterTimeoutMs = Math.max(0, options.exporterTimeoutMs ?? 10_000);
    this.onExporterError = options.onExporterError;
  }

  private awaitExporter<T>(operation: Promise<T>): Promise<T> {
    operation.catch(() => undefined);
    if (this.exporterTimeoutMs === 0) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Telemetry exporter timed out after ${this.exporterTimeoutMs}ms`)),
        this.exporterTimeoutMs,
      );
    });
    return Promise.race([operation, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  getLastExporterError(): unknown {
    return this.lastExporterError;
  }

  private async handleExporterResults(
    results: PromiseSettledResult<unknown>[],
    exporters: TelemetryExporter[],
  ): Promise<void> {
    const failures = results.flatMap((result, index) =>
      result.status === "rejected" && exporters[index]
        ? [{ error: result.reason, exporter: exporters[index] }]
        : [],
    );
    if (!failures.length) return;
    this.lastExporterError = failures[0]?.error;
    await Promise.allSettled(
      failures.map(({ error, exporter }) => this.onExporterError?.(error, exporter)),
    );
    if (this.failOnExporterError) {
      throw failures[0]?.error instanceof Error
        ? failures[0].error
        : new Error(String(failures[0]?.error));
    }
  }

  async emit(type: RuntimeEventType, input: RuntimeEventInput = {}): Promise<RuntimeEvent> {
    const event = createRuntimeEvent(type, {
      ...input,
      payload: redactTelemetryValue(input.payload ?? {}, 0, this.captureContent) as Record<
        string,
        unknown
      >,
      error: input.error
        ? {
            ...input.error,
            message: this.captureContent ? input.error.message : "[redacted]",
            ...(input.error.details
              ? {
                  details: redactTelemetryValue(
                    input.error.details,
                    0,
                    this.captureContent,
                  ) as Record<string, unknown>,
                }
              : {}),
          }
        : undefined,
    });
    const exporters = this.exporters;
    const results = await Promise.allSettled(
      exporters.map((exporter) =>
        this.awaitExporter(Promise.resolve().then(() => exporter.export(event))),
      ),
    );
    await this.handleExporterResults(results, exporters);
    return event;
  }

  async flush(): Promise<void> {
    const exporters = this.exporters;
    const results = await Promise.allSettled(
      exporters.map((exporter) =>
        this.awaitExporter(Promise.resolve().then(() => exporter.flush?.())),
      ),
    );
    await this.handleExporterResults(results, exporters);
  }
}

export function createTelemetry(
  options: {
    enabled?: boolean;
    exporter?: "memory" | "jsonl" | "otel" | "convex" | TelemetryExporter | TelemetryExporter[];
    path?: string;
    convexUrl?: string;
    convexApiKey?: string;
    convexBatchSize?: number;
    convexTimeoutMs?: number;
    captureContent?: boolean;
    failOnExporterError?: boolean;
    exporterTimeoutMs?: number;
    onExporterError?: (error: unknown, exporter: TelemetryExporter) => void | Promise<void>;
  } = {},
): Telemetry {
  if (options.enabled === false) return new Telemetry();
  const selected = options.exporter ?? "memory";
  const exporters = Array.isArray(selected)
    ? selected
    : typeof selected === "object"
      ? [selected]
      : selected === "jsonl"
        ? [new JsonlTelemetryExporter(options.path ?? "runtime-events.jsonl")]
        : selected === "otel"
          ? [new OpenTelemetryExporter()]
          : selected === "convex"
            ? options.convexUrl
              ? [
                  new ConvexTelemetryExporter({
                    url: options.convexUrl,
                    apiKey: options.convexApiKey,
                    batchSize: options.convexBatchSize,
                    timeoutMs: options.convexTimeoutMs,
                  }),
                ]
              : []
            : [new MemoryTelemetryExporter()];
  return new Telemetry(exporters, {
    captureContent: options.captureContent,
    failOnExporterError: options.failOnExporterError,
    exporterTimeoutMs: options.exporterTimeoutMs,
    onExporterError: options.onExporterError,
  });
}
