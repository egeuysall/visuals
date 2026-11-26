import { createServer } from "node:http";
import { join } from "node:path";
import { createMCPGateway, createMcpHttpHandler, McpGateway } from "@runto/mcp";
import { describe, expect, it } from "vitest";

describe("MCP aggregation", () => {
  it("connects over stdio, namespaces tools, and routes validated calls", async () => {
    const gateway = new McpGateway([
      {
        id: "fixture",
        transport: "stdio",
        command: process.execPath,
        args: [join(process.cwd(), "fixtures/mcp-servers/echo-server.mjs")],
        cwd: process.cwd(),
      },
    ]);
    try {
      const tools = await gateway.refresh();
      expect(tools.map((tool) => tool.id)).toContain("fixture/echo");
      expect(gateway.searchTools("echo")[0]?.id).toBe("fixture/echo");
      await expect(
        gateway.executeTool(
          "fixture/echo",
          { text: "hello" },
          { runId: "test", traceId: "test", signal: new AbortController().signal, metadata: {} },
        ),
      ).resolves.toEqual({ text: "echo:hello" });
    } finally {
      await gateway.close();
    }
  }, 20_000);

  it("uses a fresh stateless HTTP MCP transport for repeated requests", async () => {
    const gateway = new McpGateway([]);
    await gateway.refresh();
    const handler = createMcpHttpHandler(gateway);
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      await handler(request, response, body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("MCP test server did not bind");
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const initialize = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
      const list = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(initialize.status).toBe(200);
      expect(list.status).toBe(200);
      expect(await list.text()).toContain("search_tools");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await gateway.close();
    }
  }, 20_000);

  it("enforces exact tool allowlists and exposes an owned shutdown handle", async () => {
    const handle = await createMCPGateway({
      servers: [
        {
          id: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: [join(process.cwd(), "fixtures/mcp-servers/echo-server.mjs")],
          cwd: process.cwd(),
        },
      ],
      allowedTools: ["fixture/echo"],
    });
    try {
      expect(handle.tools.map((tool) => tool.id)).toEqual(["fixture/echo"]);
      expect(() => handle.gateway.inspectTool("fixture/blocked")).toThrow();
    } finally {
      await handle.close();
    }
  }, 20_000);
});
