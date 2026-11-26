import { validateToolInput } from "./runtime.js";
import type { HistoricalTraceStep, RuntimeTool, SideEffect } from "./types.js";

export type { HistoricalTraceStep } from "./types.js";

export interface SpeculationOptions {
  minConfidence?: number;
  maxCostUsd?: number;
  maxConcurrency?: number;
  allowedTools?: string[];
  denySideEffects?: SideEffect[];
}

export interface SpeculativeResult<T = unknown> {
  toolId: string;
  arguments: unknown;
  value?: T;
  accepted: boolean;
  reason?: string;
}

function same(value: unknown, other: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(other);
}

export class ReadOnlySpeculationController {
  constructor(private readonly options: SpeculationOptions = {}) {}

  async simulate<T>(
    steps: HistoricalTraceStep[],
    tools: Map<string, RuntimeTool>,
    context: { runId: string; traceId: string; signal: AbortSignal },
  ): Promise<SpeculativeResult<T>[]> {
    const minimum = this.options.minConfidence ?? 0.8;
    const budget = this.options.maxCostUsd ?? Number.POSITIVE_INFINITY;
    const selected = steps.filter(
      (step) =>
        step.confidence >= minimum && (step.sideEffect === "none" || step.sideEffect === "read"),
    );
    const results: SpeculativeResult<T>[] = [];
    let spent = 0;
    const selectedSteps = selected;
    for (
      let offset = 0;
      offset < selectedSteps.length;
      offset += this.options.maxConcurrency ?? 4
    ) {
      const batch = selectedSteps.slice(offset, offset + (this.options.maxConcurrency ?? 4));
      const runnable: HistoricalTraceStep[] = [];
      for (const step of batch) {
        if (spent + (step.estimatedCostUsd ?? 0) > budget) {
          results.push({
            toolId: step.toolId,
            arguments: step.arguments,
            accepted: false,
            reason: "cost-budget",
          });
        } else {
          runnable.push(step);
          spent += step.estimatedCostUsd ?? 0;
        }
      }
      const batchResults = await Promise.all(
        runnable.map(async (step): Promise<SpeculativeResult<T>> => {
          const tool = tools.get(step.toolId);
          if (!tool || !["none", "read"].includes(tool.metadata.sideEffect))
            return {
              toolId: step.toolId,
              arguments: step.arguments,
              accepted: false,
              reason: "not-read-only",
            };
          if (
            (this.options.allowedTools && !this.options.allowedTools.includes(tool.id)) ||
            this.options.denySideEffects?.includes(tool.metadata.sideEffect)
          )
            return {
              toolId: step.toolId,
              arguments: step.arguments,
              accepted: false,
              reason: "runtime-policy",
            };
          const inputError = validateToolInput(step.arguments, tool.inputSchema);
          if (inputError)
            return {
              toolId: step.toolId,
              arguments: step.arguments,
              accepted: false,
              reason: inputError,
            };
          try {
            if (context.signal.aborted) throw new DOMException("Speculation aborted", "AbortError");
            const value = (await tool.execute(step.arguments, {
              ...context,
              metadata: { speculative: true },
            })) as T;
            return {
              toolId: step.toolId,
              arguments: step.arguments,
              value,
              accepted: false,
              reason: "awaiting-authoritative-match",
            };
          } catch (error) {
            return {
              toolId: step.toolId,
              arguments: step.arguments,
              accepted: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      results.push(...batchResults);
    }
    return results;
  }

  commit<T>(
    speculative: SpeculativeResult<T>,
    authoritative: { toolId: string; arguments: unknown },
  ): T | undefined {
    if (
      speculative.toolId !== authoritative.toolId ||
      !same(speculative.arguments, authoritative.arguments)
    )
      return undefined;
    return speculative.value;
  }
}
