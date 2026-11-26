import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHttpHandler, McpGateway, type McpServerConfig } from "@runto/mcp";

export interface GatewayOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  servers?: McpServerConfig[];
  requestsPerMinute?: number;
  allowedTools?: readonly string[];
  projectId?: string;
  environment?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBytes) throw new HttpError(413, "Request body too large");
    chunks.push(value);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function authorized(request: IncomingMessage, apiKey?: string): boolean {
  if (!apiKey) return true;
  const supplied = request.headers.authorization ?? "";
  const expected = `Bearer ${apiKey}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

class FixedWindowLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      if (this.buckets.size > 10_000) {
        for (const [entryKey, entry] of this.buckets)
          if (now - entry.startedAt >= 60_000) this.buckets.delete(entryKey);
      }
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }
}

export async function createGatewayServer(options: GatewayOptions = {}) {
  const host = options.host ?? process.env.NAVO_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.NAVO_PORT ?? 8787);
  const apiKey = options.apiKey ?? process.env.NAVO_API_KEY;
  const allowedTools = options.allowedTools ?? parseAllowedTools(process.env.NAVO_ALLOWED_TOOLS);
  const limiter = new FixedWindowLimiter(
    Math.max(1, options.requestsPerMinute ?? Number(process.env.NAVO_RATE_LIMIT_PER_MINUTE ?? 120)),
  );
  const loopback = isLoopbackHost(host);
  if (!loopback && !apiKey)
    throw new Error("NAVO_API_KEY is required when the gateway is not loopback-bound");
  if (!loopback && !allowedTools?.length)
    throw new Error("NAVO_ALLOWED_TOOLS is required when the gateway is not loopback-bound");
  const gateway = new McpGateway(options.servers ?? parseServers(process.env.NAVO_MCP_SERVERS), {
    allowedTools,
    projectId: options.projectId ?? process.env.NAVO_PROJECT_ID,
    environment: options.environment ?? process.env.NAVO_ENVIRONMENT,
  });
  await gateway.refresh();
  const mcpHandler = createMcpHttpHandler(gateway);
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET")
        return send(response, 200, { ok: true, tools: (await gateway.currentTools()).length });
      if (!limiter.allow(request.socket.remoteAddress ?? "unknown"))
        return send(response, 429, { error: "Rate limit exceeded" });
      if (!authorized(request, apiKey)) return send(response, 401, { error: "Unauthorized" });
      if (request.url === "/v1/tools" && request.method === "GET")
        return send(
          response,
          200,
          (await gateway.currentTools()).map((tool) => ({
            id: tool.id,
            name: tool.name,
            description: tool.description,
            metadata: tool.metadata,
          })),
        );
      if (request.url === "/v1/search" && request.method === "POST") {
        const input = (await body(request)) as { query?: string; topK?: number };
        if (!input?.query) return send(response, 400, { error: "query is required" });
        return send(response, 200, await gateway.searchToolsFresh(input.query, input.topK));
      }
      if (request.url === "/v1/inspect" && request.method === "POST") {
        const input = (await body(request)) as { toolId?: string };
        if (!input?.toolId) return send(response, 400, { error: "toolId is required" });
        const tool = await gateway.inspectToolFresh(input.toolId);
        return send(response, 200, {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          metadata: tool.metadata,
        });
      }
      if (request.url === "/v1/execute" && request.method === "POST") {
        const input = (await body(request)) as { toolId?: string; arguments?: unknown };
        if (!input?.toolId) return send(response, 400, { error: "toolId is required" });
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        const result = await gateway.executeTool(input.toolId, input.arguments, {
          runId: "gateway",
          traceId: "gateway",
          signal: controller.signal,
          metadata: {},
        });
        return send(response, 200, result);
      }
      if (request.url === "/mcp")
        return await mcpHandler(
          request,
          response,
          request.method === "POST" ? await body(request) : undefined,
        );
      send(response, 404, { error: "Not found" });
    } catch (error) {
      send(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : "Gateway request failed",
      });
    }
  });
  return {
    server,
    gateway,
    host,
    port,
    listen: () => new Promise<void>((resolve) => server.listen(port, host, () => resolve())),
    close: async () => {
      await gateway.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}

function parseAllowedTools(value?: string): string[] | undefined {
  if (!value?.trim()) return undefined;
  return [
    ...new Set(
      value
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean),
    ),
  ];
}

function parseServers(value?: string): McpServerConfig[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    throw new Error("NAVO_MCP_SERVERS must be valid JSON");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createGatewayServer();
  await app.listen();
  console.log(`Navo gateway listening on http://${app.host}:${app.port}`);
}
