export type ArmName = "baseline" | "optimized";

/** One model call or tool call, in ms from the start of its run. */
export interface Span {
  kind: "model" | "tool";
  name: string;
  start: number;
  end: number;
}

export interface ArmResult {
  latencyMs: number;
  modelMs: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  success: boolean;
  /** Key incident facts the answer mentions. A keyword check, not a grade of the reasoning. */
  facts: { found: number; total: number };
  error?: string;
  output: string;
  spans: Span[];
}

export interface Levers {
  parallel: boolean;
  compact: boolean;
  schema: boolean;
  /** Whether the optimized arm keeps the model's reasoning on. The baseline always does. */
  thinking: boolean;
}

export interface Run {
  id: string;
  createdAt: number;
  task: string;
  model: string;
  /** USD per million tokens, used for the cost estimates. */
  pricing: { input: number; output: number };
  levers: Levers;
  memory: "used" | "empty" | "off" | "error";
  baseline: ArmResult;
  optimized: ArmResult;
}

export type StreamEvent =
  | { type: "log"; text: string }
  | { type: "run"; run: Run }
  | { type: "reset" };
