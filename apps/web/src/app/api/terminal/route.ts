import { currentUser } from "@/lib/server/auth";
import { execute } from "@/lib/server/commands";
import type { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Runs one terminal line for the signed-in user and streams what it prints, one JSON object per line. */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host"))
    return new Response("cross-origin request", { status: 403 });
  const user = await currentUser();
  if (!user) return new Response("sign in again", { status: 401 });

  const body = (await req.json().catch(() => null)) as { line?: unknown } | null;
  const line = typeof body?.line === "string" ? body.line.trim() : "";
  if (!line || line.length > 4_000) return new Response("bad command", { status: 400 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await execute(user, line, emit, abort.signal);
      } catch (error) {
        console.error(error);
        emit({ type: "log", text: "the command failed. check the server log." });
      }
      if (!abort.signal.aborted) controller.close();
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
