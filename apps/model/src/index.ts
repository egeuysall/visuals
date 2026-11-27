/**
 * The one model call the web app needs, on Cloudflare Workers AI. It stores and logs nothing.
 *
 *   POST /run  { messages, tools?, tool_choice?, max_tokens?, reasoning_effort?, thinking? }  ->  { model, output }
 *
 * Under `wrangler dev` it answers on localhost without a token. Anywhere else MODEL_PROXY_TOKEN
 * is required, so a deployed copy cannot be used by strangers.
 */
interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  MODEL: string;
  MODEL_PROXY_TOKEN?: string;
}

const MAX_BODY_CHARS = 400_000;
function allowed(request: Request, env: Env): boolean {
  if (env.MODEL_PROXY_TOKEN)
    return request.headers.get("authorization") === `Bearer ${env.MODEL_PROXY_TOKEN}`;
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response("not found", { status: 404 });
    if (!allowed(request, env)) return new Response("unauthorized", { status: 401 });
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return new Response("too large", { status: 413 });
    try {
      const { messages, tools, tool_choice, max_tokens, reasoning_effort, thinking } =
        JSON.parse(text);
      const output = await env.AI.run(env.MODEL, {
        messages,
        ...(tools?.length
          ? {
              tools,
              parallel_tool_calls: true,
              ...(tool_choice === "required" ? { tool_choice } : {}),
            }
          : {}),
        max_tokens: Math.min(Number(max_tokens) || 2048, 4096),
        ...(reasoning_effort ? { reasoning_effort } : {}),
        ...(typeof thinking === "boolean"
          ? { chat_template_kwargs: { enable_thinking: thinking } }
          : {}),
      });
      return Response.json({ model: env.MODEL, output });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 502 },
      );
    }
  },
};
