import { McpServer } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import { z } from "../../packages/mcp/node_modules/zod/index.js";

const server = new McpServer({ name: "aar-fixture", version: "0.1.0" });
server.registerTool(
  "echo",
  { description: "Echo text for gateway tests", inputSchema: { text: z.string().min(1) } },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
    structuredContent: { text: `echo:${text}` },
  }),
);
await server.connect(new StdioServerTransport());
