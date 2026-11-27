import { randomUUID } from "node:crypto";

export interface ResultCompileOptions {
  maxInlineBytes?: number;
  maxPreviewBytes?: number;
  fields?: string[];
  sortBy?: string;
  filter?: { field: string; equals: unknown };
  aggregate?: { count?: boolean; sum?: string };
  provenance?: string;
}

export interface CompiledToolResult {
  content: string;
  inline: boolean;
  handle?: string;
  preview: unknown;
  sizeBytes: number;
  provenance?: string;
}

export interface ResultCompiler {
  compile(value: unknown, options?: ResultCompileOptions): CompiledToolResult;
  get(handle: string): unknown;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function project(value: unknown, options: ResultCompileOptions): unknown {
  if (!Array.isArray(value)) {
    if (!value || typeof value !== "object" || !options.fields?.length) return value;
    return Object.fromEntries(
      options.fields
        .filter((field) => field in value)
        .map((field) => [field, (value as Record<string, unknown>)[field]]),
    );
  }
  let rows = value;
  if (options.filter)
    rows = rows.filter(
      (row) =>
        row &&
        typeof row === "object" &&
        (row as Record<string, unknown>)[options.filter?.field ?? ""] === options.filter?.equals,
    );
  if (options.sortBy) {
    rows = [...rows].sort((left, right) =>
      String((left as Record<string, unknown>)?.[options.sortBy ?? ""] ?? "").localeCompare(
        String((right as Record<string, unknown>)?.[options.sortBy ?? ""] ?? ""),
      ),
    );
  }
  if (options.fields?.length) rows = rows.map((row) => project(row, options));
  if (options.aggregate) {
    return {
      ...(options.aggregate.count ? { count: rows.length } : {}),
      ...(options.aggregate.sum
        ? {
            sum: rows.reduce(
              (total, row) =>
                total +
                Number((row as Record<string, unknown>)?.[options.aggregate?.sum ?? ""] ?? 0),
              0,
            ),
          }
        : {}),
    };
  }
  return rows;
}

/**
 * Keeps whole fields, in order, while they fit in the budget. Only a field that does not fit is
 * summarized, so one huge array cannot push the small fields around it out of the preview.
 */
function fitFields(entries: [string, unknown][], maxBytes: number): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (bytes(JSON.stringify({ ...kept, [key]: item })) <= maxBytes) kept[key] = item;
    else if (Array.isArray(item)) kept[key] = { type: "array", count: item.length };
    else if (typeof item === "string") kept[key] = `${item.slice(0, 120)}…`;
    else kept[key] = "[omitted]";
  }
  return kept;
}

function preview(value: unknown, depth = 0, maxBytes = 2_000): unknown {
  const compact = (candidate: unknown, fallback: unknown): unknown =>
    bytes(JSON.stringify(candidate)) <= maxBytes ? candidate : fallback;
  if (depth >= 3) return typeof value === "string" ? value.slice(0, 240) : "[nested value]";
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (Array.isArray(value))
    return compact(
      {
        type: "array",
        count: value.length,
        items: value.slice(0, 3).map((item) => preview(item, depth + 1, maxBytes)),
      },
      { type: "array", count: value.length },
    );
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const candidate = {
      type: "object",
      keys: entries.map(([key]) => key),
      value: Object.fromEntries(
        entries.slice(0, 10).map(([key, item]) => [key, preview(item, depth + 1, maxBytes)]),
      ),
    };
    return compact(candidate, {
      type: "object",
      keys: candidate.keys,
      value: fitFields(entries, maxBytes),
    });
  }
  return value;
}

export class MemoryResultCompiler implements ResultCompiler {
  private readonly values = new Map<string, unknown>();

  constructor(
    private readonly defaultMaxInlineBytes = 20_000,
    private readonly maxHandles = 1_024,
    private readonly defaultMaxPreviewBytes = 2_000,
  ) {}

  compile(value: unknown, options: ResultCompileOptions = {}): CompiledToolResult {
    const projected = project(value, options);
    const serialized = JSON.stringify(projected);
    const sizeBytes = bytes(serialized);
    const maxInlineBytes = options.maxInlineBytes ?? this.defaultMaxInlineBytes;
    if (sizeBytes <= maxInlineBytes) {
      return {
        content: serialized,
        inline: true,
        preview: projected,
        sizeBytes,
        ...(options.provenance ? { provenance: options.provenance } : {}),
      };
    }
    const handle = `result://${randomUUID()}`;
    if (this.values.size >= Math.max(1, this.maxHandles))
      this.values.delete(this.values.keys().next().value as string);
    this.values.set(handle, value);
    const resultPreview = preview(
      projected,
      0,
      Math.max(128, options.maxPreviewBytes ?? this.defaultMaxPreviewBytes),
    );
    const compact = JSON.stringify({
      handle,
      sizeBytes,
      preview: resultPreview,
      ...(options.provenance ? { provenance: options.provenance } : {}),
    });
    return {
      content: compact,
      inline: false,
      handle,
      preview: resultPreview,
      sizeBytes,
      ...(options.provenance ? { provenance: options.provenance } : {}),
    };
  }

  get(handle: string): unknown {
    return this.values.get(handle);
  }
}
