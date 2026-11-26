import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createToolRegistry,
  type JsonSchema,
  type RuntimeTool,
  type ToolContext,
  type ToolSummary,
  validateToolInput,
} from "@runto/core";
import type { Telemetry } from "@runto/telemetry";
import { z } from "zod";

export interface McpServerConfigBase {
  id: string;
  sideEffect?: RuntimeTool["metadata"]["sideEffect"];
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

interface UpstreamClient {
  config: McpServerConfig;
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<Array<Record<string, unknown>>>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

function sideEffectForTool(
  tool: Record<string, unknown>,
  fallback: RuntimeTool["metadata"]["sideEffect"],
): RuntimeTool["metadata"]["sideEffect"] {
  const annotations = tool.annotations as Record<string, unknown> | undefined;
  if (annotations?.destructiveHint === true) return "write";
  if (annotations?.readOnlyHint === true) return "read";
  return fallback;
}

function createUpstreamClient(config: McpServerConfig, onToolsChanged: () => void): UpstreamClient {
  let client: Client | undefined;
  let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
  let connected = false;
  const createTransport = () =>
    config.transport === "stdio"
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        } satisfies StdioServerParameters)
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
  return {
    config,
    async connect() {
      if (!connected) {
        client = new Client(
          { name: "navo-gateway", version: "0.1.0" },
          {
            capabilities: {},
            listChanged: {
              tools: { onChanged: () => onToolsChanged() },
            },
          },
        );
        transport = createTransport();
        await client.connect(transport);
        connected = true;
      }
    },
    async close() {
      await client?.close();
      await transport?.close();
      connected = false;
    },
    async listTools() {
      try {
        await this.connect();
        const result = await client?.listTools();
        if (!result) throw new Error(`MCP server ${config.id} did not connect`);
        return result.tools as unknown as Array<Record<string, unknown>>;
      } catch (error) {
        await Promise.allSettled([client?.close(), transport?.close()]);
        client = undefined;
        transport = undefined;
        connected = false;
        throw error;
      }
    },
    async callTool(name, args, signal) {
      try {
        await this.connect();
        if (!client) throw new Error(`MCP server ${config.id} did not connect`);
        return await client.callTool(
          { name, arguments: args as Record<string, unknown> },
          undefined,
          signal ? { signal } : undefined,
        );
      } catch (error) {
        await Promise.allSettled([client?.close(), transport?.close()]);
        client = undefined;
        transport = undefined;
        connected = false;
        throw error;
      }
    },
  };
}

export interface McpGatewayOptions {
  telemetry?: Telemetry;
  toolListTtlMs?: number;
  projectId?: string;
  environment?: string;
  allowedTools?: readonly string[];
}

interface ToolListCacheEntry {
  tools: Array<Record<string, unknown>>;
  fingerprint: string;
  expiresAt: number;
}

function upstreamResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const object = result as Record<string, unknown>;
  if (object.isError) throw new Error(String(object.error ?? "Upstream MCP tool failed"));
  return object.structuredContent ?? object.content ?? result;
}

export class McpGateway {
  private readonly clients: UpstreamClient[];
  private readonly toolsById = new Map<string, RuntimeTool>();
  private readonly toolListCache = new Map<string, ToolListCacheEntry>();
  private readonly invalidatedServers = new Set<string>();
  private readonly telemetry?: Telemetry;
  private readonly toolListTtlMs: number;
  private readonly projectId?: string;
  private readonly environment?: string;
  private readonly allowedTools?: ReadonlySet<string>;
  private loaded = false;

  constructor(configs: McpServerConfig[], options: McpGatewayOptions = {}) {
    this.telemetry = options.telemetry;
    this.toolListTtlMs = Math.max(0, options.toolListTtlMs ?? 30_000);
    this.projectId = options.projectId;
    this.environment = options.environment;
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
    const ids = new Set<string>();
    for (const config of configs) {
      if (ids.has(config.id)) throw new Error(`Duplicate MCP server id: ${config.id}`);
      ids.add(config.id);
    }
    this.clients = configs.map((config) =>
      createUpstreamClient(config, () => {
        this.invalidatedServers.add(config.id);
        this.loaded = false;
        this.toolsById.clear();
      }),
    );
  }

  async refresh(options: { force?: boolean } = {}): Promise<RuntimeTool[]> {
    if (
      this.loaded &&
      !options.force &&
      this.clients.every((client) => {
        const cached = this.toolListCache.get(client.config.id);
        return (
          cached && cached.expiresAt > Date.now() && !this.invalidatedServers.has(client.config.id)
        );
      })
    )
      return this.tools();
    this.toolsById.clear();
    const gateway = this;
    let changed = false;
    for (const client of this.clients) {
      const cached = this.toolListCache.get(client.config.id);
      const useCache =
        !options.force &&
        !this.invalidatedServers.has(client.config.id) &&
        cached !== undefined &&
        cached.expiresAt > Date.now();
      const tools = useCache && cached ? cached.tools : await client.listTools();
      const fingerprint = JSON.stringify(tools);
      if (!cached || cached.fingerprint !== fingerprint) changed = true;
      if (!useCache)
        this.toolListCache.set(client.config.id, {
          tools,
          fingerprint,
          expiresAt: Date.now() + this.toolListTtlMs,
        });
      for (const upstream of tools) {
        const upstreamName = String(upstream.name);
        const id = `${client.config.id}/${upstreamName}`;
        if (this.allowedTools && !this.allowedTools.has(id)) continue;
        const inputSchema = (upstream.inputSchema ?? {
          type: "object",
          properties: {},
        }) as JsonSchema;
        const tool: RuntimeTool = {
          id,
          name: id,
          description: String(upstream.description ?? upstream.title ?? upstreamName),
          inputSchema,
          metadata: {
            server: client.config.id,
            sideEffect: sideEffectForTool(upstream, client.config.sideEffect ?? "write"),
            idempotent:
              sideEffectForTool(upstream, client.config.sideEffect ?? "write") !== "irreversible",
            examples: Array.isArray(upstream.examples) ? upstream.examples : undefined,
          },
          async execute(input: unknown, context: ToolContext): Promise<unknown> {
            if (context.signal.aborted) throw new DOMException("Tool call aborted", "AbortError");
            const error = validateToolInput(input, inputSchema);
            if (error) throw new Error(error);
            const started = Date.now();
            await gateway.telemetry?.emit("tool.started", {
              projectId: gateway.projectId,
              environment: gateway.environment,
              runId: context.runId,
              traceId: context.traceId,
              provider: "mcp",
              tool: id,
              inputSize: JSON.stringify(input).length,
              payload: { server: client.config.id },
            });
            try {
              const result = upstreamResult(
                await client.callTool(upstreamName, input, context.signal),
              );
              await gateway.telemetry?.emit("tool.completed", {
                projectId: gateway.projectId,
                environment: gateway.environment,
                runId: context.runId,
                traceId: context.traceId,
                provider: "mcp",
                tool: id,
                durationMs: Date.now() - started,
                outputSize: JSON.stringify(result).length,
                success: true,
                payload: { server: client.config.id },
              });
              return result;
            } catch (error) {
              await gateway.telemetry?.emit("tool.failed", {
                projectId: gateway.projectId,
                environment: gateway.environment,
                runId: context.runId,
                traceId: context.traceId,
                provider: "mcp",
                tool: id,
                durationMs: Date.now() - started,
                success: false,
                error: {
                  name: error instanceof Error ? error.name : "McpToolError",
                  message: error instanceof Error ? error.message : String(error),
                },
              });
              throw error;
            }
          },
        };
        this.toolsById.set(id, tool);
      }
    }
    this.invalidatedServers.clear();
    this.loaded = true;
    if (changed)
      await this.telemetry?.emit("tool.registry.updated", {
        projectId: this.projectId,
        environment: this.environment,
        provider: "mcp",
        success: true,
        payload: { count: this.toolsById.size },
      });
    return this.tools();
  }

  tools(): RuntimeTool[] {
    return [...this.toolsById.values()];
  }

  async currentTools(): Promise<RuntimeTool[]> {
    await this.refresh();
    return this.tools();
  }

  searchTools(query: string, topK = 5): ToolSummary[] {
    return createToolRegistry(this.tools()).search(query, { strategy: "bm25", topK });
  }

  async searchToolsFresh(query: string, topK = 5): Promise<ToolSummary[]> {
    await this.refresh();
    return this.searchTools(query, topK);
  }

  inspectTool(toolId: string): RuntimeTool {
    const tool = this.toolsById.get(toolId);
    if (!tool) throw new Error(`Unknown MCP tool: ${toolId}`);
    return tool;
  }

  async inspectToolFresh(toolId: string): Promise<RuntimeTool> {
    await this.refresh();
    return this.inspectTool(toolId);
  }

  async executeTool(toolId: string, input: unknown, context: ToolContext): Promise<unknown> {
    if (!this.loaded) await this.refresh();
    return this.inspectTool(toolId).execute(input, context);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
    this.toolListCache.clear();
    this.invalidatedServers.clear();
    this.loaded = false;
  }
}

export interface McpToolsHandle {
  gateway: McpGateway;
  tools: RuntimeTool[];
  close(): Promise<void>;
}

export type McpTools = RuntimeTool[] & { close(): Promise<void> };

export async function createMCPGateway(options: {
  servers: McpServerConfig[];
  telemetry?: Telemetry;
  toolListTtlMs?: number;
  projectId?: string;
  environment?: string;
  allowedTools?: readonly string[];
}): Promise<McpToolsHandle> {
  const gateway = new McpGateway(options.servers, options);
  return { gateway, tools: await gateway.refresh(), close: () => gateway.close() };
}

/**
 * @deprecated Prefer createMCPGateway. The returned array has a close() method
 * for compatibility with callers that still want the convenience API.
 */
export async function createMCPTools(options: {
  servers: McpServerConfig[];
  telemetry?: Telemetry;
  toolListTtlMs?: number;
  projectId?: string;
  environment?: string;
  allowedTools?: readonly string[];
}): Promise<McpTools> {
  const handle = await createMCPGateway(options);
  const tools = handle.tools as McpTools;
  Object.defineProperty(tools, "close", { value: handle.close, enumerable: false });
  return tools;
}

export function createMcpServer(gateway: McpGateway): McpServer {
  const server = new McpServer({ name: "navo-gateway", version: "0.1.0" });
  server.registerTool(
    "search_tools",
    {
      description: "Search aggregated upstream MCP tools",
      inputSchema: { query: z.string().min(1), topK: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, topK }) => {
      const tools = await gateway.searchToolsFresh(query, topK);
      return {
        content: [{ type: "text", text: JSON.stringify(tools) }],
        structuredContent: { tools },
      };
    },
  );
  server.registerTool(
    "inspect_tool",
    { description: "Inspect an aggregated MCP tool", inputSchema: { toolId: z.string().min(1) } },
    async ({ toolId }) => {
      const tool = await gateway.inspectToolFresh(toolId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: tool.id,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              metadata: tool.metadata,
            }),
          },
        ],
        structuredContent: {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          metadata: tool.metadata,
        },
      };
    },
  );
  server.registerTool(
    "execute_tool",
    {
      description: "Execute an aggregated MCP tool",
      inputSchema: { toolId: z.string().min(1), arguments: z.record(z.string(), z.unknown()) },
    },
    async ({ toolId, arguments: input }, extra) => {
      const result = await gateway.executeTool(toolId, input, {
        runId: "mcp-gateway",
        traceId: "mcp-gateway",
        signal: extra.signal,
        metadata: {},
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    },
  );
  return server;
}

export async function runMcpStdioServer(gateway: McpGateway): Promise<void> {
  const server = createMcpServer(gateway);
  await server.connect(new StdioServerTransport());
}

export function createMcpHttpHandler(
  gateway: McpGateway,
): (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body?: unknown,
) => Promise<void> {
  return async (req, res, body) => {
    const server = createMcpServer(gateway);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      await Promise.allSettled([transport.close(), server.close()]);
    }
  };
}
