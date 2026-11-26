import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeEvent, type RuntimeEvent } from "@runto/protocol";
import { JsonlTelemetryExporter } from "@runto/telemetry";

const path = process.env.NAVO_EVENT_LOG ?? "runtime-events.jsonl";
const exporter = new JsonlTelemetryExporter(path);
const apiKey = process.env.NAVO_TRACE_API_KEY ?? process.env.NAVO_API_KEY;
const host = process.env.NAVO_HOST ?? "127.0.0.1";
const maxBodyBytes = 2_000_000;
const maxBatchSize = 100;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBodyBytes) throw new HttpError(413, "Request body too large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function authorized(request: import("node:http").IncomingMessage): boolean {
  if (!apiKey) return true;
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const buckets = new Map<string, { startedAt: number; count: number }>();
const rateLimit = Math.max(1, Number(process.env.NAVO_RATE_LIMIT_PER_MINUTE ?? 120));
function allowed(request: import("node:http").IncomingMessage): boolean {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    buckets.set(key, { startedAt: now, count: 1 });
    if (buckets.size > 10_000) {
      for (const [entryKey, entry] of buckets)
        if (now - entry.startedAt >= 60_000) buckets.delete(entryKey);
    }
    return true;
  }
  if (bucket.count >= rateLimit) return false;
  bucket.count += 1;
  return true;
}

if (!["127.0.0.1", "localhost", "::1"].includes(host) && !apiKey)
  throw new Error("NAVO_TRACE_API_KEY is required when trace ingestion is not loopback-bound");

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (!allowed(request)) {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }
    if (!authorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "Unauthorized" }));
    }
    if (request.method !== "POST" || request.url !== "/v1/events") {
      response.writeHead(404);
      return response.end();
    }
    const input = await readJson(request);
    const events = Array.isArray(input) ? input : [input];
    if (events.length > maxBatchSize) throw new HttpError(413, "Event batch too large");
    const parsed = events.map(parseRuntimeEvent) as RuntimeEvent[];
    await Promise.all(parsed.map((event) => exporter.export(event)));
    await exporter.flush();
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: parsed.length }));
  } catch (error) {
    response.writeHead(error instanceof HttpError ? error.status : 400, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        error: error instanceof HttpError ? error.message : "Invalid event payload",
      }),
    );
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.NAVO_TRACE_PORT ?? 8788);
  server.listen(port, host, () =>
    console.log(`Trace ingestion listening on http://${host}:${port}`),
  );
}

export { server };
