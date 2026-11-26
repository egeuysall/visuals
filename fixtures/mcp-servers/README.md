# MCP fixtures

The gateway accepts `NAVO_MCP_SERVERS` as a JSON array of stdio or Streamable
HTTP server configurations. Tests use an in-memory gateway fixture so they do
not spawn arbitrary processes.
