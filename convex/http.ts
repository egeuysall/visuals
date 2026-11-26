import { parseRuntimeEvent } from "@runto/protocol";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.NAVO_CONVEX_INGEST_KEY;
    if (!expected)
      return new Response(JSON.stringify({ error: "Ingest key is not configured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    if (request.headers.get("authorization") !== `Bearer ${expected}`)
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const input: unknown = await request.json();
    const values = Array.isArray(input) ? input : [input];
    if (values.length > 100) return new Response("batch too large", { status: 413 });
    const events = values.map(parseRuntimeEvent);
    const result = await ctx.runMutation(internal.events.ingest, { events });
    return Response.json(result, { status: 202 });
  }),
});

export default http;
