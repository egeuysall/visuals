import type { Provider, ProviderRequest, ProviderResponse } from "./types.js";

export interface ReplayExchange {
  request: Omit<ProviderRequest, "signal">;
  response: ProviderResponse;
}

export interface ReplayTrace {
  provider: string;
  model: string;
  exchanges: ReplayExchange[];
}

function snapshot<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function requestKey(request: ProviderRequest): string {
  return JSON.stringify({
    instructions: request.instructions,
    messages: request.messages,
    tools: request.tools,
  });
}

export function createReplayTrace(provider: Provider): ReplayTrace {
  return { provider: provider.name, model: provider.model, exchanges: [] };
}

export function createRecordingProvider(
  provider: Provider,
  trace = createReplayTrace(provider),
): Provider {
  return {
    ...provider,
    async generate(request) {
      const response = await provider.generate(request);
      trace.exchanges.push({
        request: snapshot({
          messages: request.messages,
          tools: request.tools,
          instructions: request.instructions,
        }),
        response: snapshot(response),
      });
      return response;
    },
  };
}

export function createReplayProvider(
  trace: ReplayTrace,
  options: { strictRequests?: boolean } = {},
): Provider {
  let cursor = 0;
  return {
    name: `replay:${trace.provider}`,
    model: trace.model,
    async generate(request) {
      const exchange = trace.exchanges[cursor++];
      if (!exchange) throw new Error("Replay exhausted before runtime completion");
      if (options.strictRequests !== false && requestKey(request) !== requestKey(exchange.request))
        throw new Error(`Replay diverged at model call ${cursor}`);
      return snapshot(exchange.response);
    },
  };
}

export interface ReplayComparison {
  equal: boolean;
  reason?: string;
}

export function compareReplay(expected: ReplayTrace, actual: ReplayTrace): ReplayComparison {
  if (expected.exchanges.length !== actual.exchanges.length)
    return { equal: false, reason: "model-call-count" };
  for (let index = 0; index < expected.exchanges.length; index += 1) {
    const left = expected.exchanges[index];
    const right = actual.exchanges[index];
    if (!left || !right || requestKey(left.request) !== requestKey(right.request))
      return { equal: false, reason: `request-${index}` };
    if (JSON.stringify(left.response) !== JSON.stringify(right.response))
      return { equal: false, reason: `response-${index}` };
  }
  return { equal: true };
}
