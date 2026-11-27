import "server-only";
import { randomUUID } from "node:crypto";
import type { Kaibo } from "kaibo";
import recorded from "@/data/recorded-benchmark.json";
import { median, ratio } from "@/lib/stats";
import type { ArmName, ArmResult, Levers, Run, StreamEvent } from "@/lib/types";
import { runArm } from "./agent";
import type { User } from "./auth";
import { deleteRuns, listRuns, saveRun, takeLiveRun } from "./db";
import { memoryFor } from "./memory";
import { DEFAULT_TASK, incidentSources } from "./scenario";
import { modelName, pricing } from "./workers-ai";

const HELP = `run ["task"]             run the task twice: baseline, then the optimized runtime
  --no-parallel          keep tool calls serial
  --no-compact           send full tool results back to the model
  --no-schema            send uncompiled tool schemas
  --thinking             keep model reasoning on in the optimized arm
remember "fact"          save to your own memory (kaibo)
recall "question"        ask your memory
stats                    your runs, as numbers
bench                    the recorded gpt-5 benchmark
tools                    what the agent can call
status                   model and memory configuration
reset                    delete your runs (memory is kept)
clear                    clear the screen`;

const MEMORY_OFF = "memory is off: set KAIBO_KEY in apps/web/.env.local.";

type Emit = (event: StreamEvent) => void;

/** Splits a line into words, keeping quoted strings together. */
export function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

const times = (before: number, after: number) => {
  const r = ratio(before, after);
  return r === null ? "n/a" : `${r.toFixed(2)}x`;
};

function table(base: Omit<ArmResult, "output" | "spans" | "success">, opt: typeof base): string {
  const rows: [string, number, number, (n: number) => string][] = [
    ["latency", base.latencyMs, opt.latencyMs, (n) => `${(n / 1000).toFixed(2)}s`],
    ["tool phase", base.toolMs, opt.toolMs, (n) => `${Math.round(n)}ms`],
    ["input tokens", base.inputTokens, opt.inputTokens, (n) => `${Math.round(n)}`],
    ["output tokens", base.outputTokens, opt.outputTokens, (n) => `${Math.round(n)}`],
    ["est. cost", base.costUsd, opt.costUsd, (n) => `$${n.toFixed(5)}`],
  ];
  return [
    `${"".padEnd(14)}${"baseline".padStart(11)}${"optimized".padStart(11)}${"gain".padStart(8)}`,
    ...rows.map(
      ([label, a, b, f]) =>
        `${label.padEnd(14)}${f(a).padStart(11)}${f(b).padStart(11)}${times(a, b).padStart(8)}`,
    ),
  ].join("\n");
}

function medians(arms: ArmResult[]): ArmResult {
  const pick = (
    k:
      | "latencyMs"
      | "toolMs"
      | "modelMs"
      | "inputTokens"
      | "outputTokens"
      | "costUsd"
      | "modelCalls"
      | "toolCalls",
  ) => median(arms.map((a) => a[k]));
  return {
    latencyMs: pick("latencyMs"),
    toolMs: pick("toolMs"),
    modelMs: pick("modelMs"),
    inputTokens: pick("inputTokens"),
    outputTokens: pick("outputTokens"),
    costUsd: pick("costUsd"),
    modelCalls: pick("modelCalls"),
    toolCalls: pick("toolCalls"),
    success: true,
    facts: { found: 0, total: 0 },
    output: "",
    spans: [],
  };
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readMemory(
  memory: Kaibo | null,
  task: string,
): Promise<{ state: Run["memory"]; text: string; note: string }> {
  if (!memory) return { state: "off", text: "", note: MEMORY_OFF };
  try {
    const pack = await memory.recall(task);
    if (!pack.found) return { state: "empty", text: "", note: "memory: nothing relevant yet." };
    return {
      state: "used",
      text: await memory.context(task),
      note: "memory: found, added to both arms.",
    };
  } catch (e) {
    return { state: "error", text: "", note: `memory failed, running without it: ${reason(e)}` };
  }
}

const running = new Set<string>();

async function run(user: User, args: string[], emit: Emit, signal: AbortSignal) {
  const log = (text: string) => emit({ type: "log", text });
  const levers: Levers = { parallel: true, compact: true, schema: true, thinking: false };
  const words: string[] = [];
  for (const arg of args) {
    if (arg === "--no-parallel") levers.parallel = false;
    else if (arg === "--no-compact") levers.compact = false;
    else if (arg === "--no-schema") levers.schema = false;
    else if (arg === "--thinking") levers.thinking = true;
    else if (arg.startsWith("--")) return log(`unknown option ${arg}. type help.`);
    else words.push(arg);
  }
  const task = words.join(" ").trim() || DEFAULT_TASK;

  if (running.has(user.id)) return log("you already have a run in progress.");
  running.add(user.id);
  try {
    if (!takeLiveRun(Number(process.env.LIVE_RUNS_PER_DAY || 50)))
      return log("today's run limit is reached (LIVE_RUNS_PER_DAY).");

    log(`model: ${modelName()} on cloudflare workers ai`);
    const memory = memoryFor(user.id);
    const recalled = await readMemory(memory, task);
    log(recalled.note);
    const input = recalled.text ? `${task}\n\n${recalled.text}` : task;

    // Random order, so neither arm always benefits from a warm provider cache.
    const order: ArmName[] =
      Math.random() < 0.5 ? ["baseline", "optimized"] : ["optimized", "baseline"];
    const results = {} as Record<ArmName, ArmResult>;
    for (const arm of order) {
      log(`running ${arm}...`);
      const r = await runArm(
        arm,
        input,
        levers,
        AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      );
      results[arm] = r;
      log(
        r.success
          ? `${arm}: ${(r.latencyMs / 1000).toFixed(2)}s, ${r.toolCalls} tool calls`
          : `${arm} failed: ${r.error ?? "empty answer"}`,
      );
    }

    const result: Run = {
      id: randomUUID(),
      createdAt: Date.now(),
      task,
      model: modelName(),
      pricing: pricing(),
      levers,
      memory: recalled.state,
      ...results,
    };
    saveRun(user.id, result);
    emit({ type: "run", run: result });
    const ok = result.baseline.success && result.optimized.success;
    log(`\n${table(result.baseline, result.optimized)}`);
    log(
      `key facts in the answer: baseline ${result.baseline.facts.found}/${result.baseline.facts.total}, optimized ${result.optimized.facts.found}/${result.optimized.facts.total}`,
    );
    if (!ok) log("one arm failed, so this run is left out of the summary.");
    else if (result.baseline.toolCalls !== result.optimized.toolCalls)
      log(
        "note: the arms made different numbers of tool calls, so this is not a like for like comparison.",
      );
    log(`\n${result.optimized.output || "(no answer)"}`);

    // Only what the user asked is stored: model output is not treated as a fact.
    if (memory && words.length) {
      try {
        await memory.remember(`The user asked the incident agent: ${task}`);
      } catch (e) {
        log(`could not save to memory: ${reason(e)}`);
      }
    }
  } finally {
    running.delete(user.id);
  }
}

export async function execute(
  user: User,
  line: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  const log = (text: string) => emit({ type: "log", text });
  let words = tokenize(line);
  if (words[0] === "visuals") words = words.slice(1);
  const [command = "help", ...args] = words;
  const text = args.join(" ").trim();

  switch (command.toLowerCase()) {
    case "help":
    case "--help":
      return log(HELP);
    case "run":
      return run(user, args, emit, signal);
    case "tools":
      return log(incidentSources.map((s) => `${s.name.padEnd(24)}${s.description}`).join("\n"));
    case "status":
      return log(
        `user      ${user.username}\nmodel     ${modelName()}\nmemory    ${process.env.KAIBO_KEY ? "kaibo, scoped to you" : "off"}`,
      );
    case "remember":
    case "recall": {
      if (!text) return log(`usage: ${command} "..."`);
      if (text.length > 2_000) return log("keep it under 2000 characters.");
      const memory = memoryFor(user.id);
      if (!memory) return log(MEMORY_OFF);
      try {
        if (command === "remember") {
          await memory.remember(text, { wait: true });
          return log("remembered.");
        }
        const pack = await memory.recall(text);
        return log(pack.found ? String(pack.answer) : `no answer: ${pack.reason}`);
      } catch (e) {
        return log(`memory failed: ${reason(e)}`);
      }
    }
    case "stats": {
      const all = listRuns(user.id).filter((r) => r.baseline.success && r.optimized.success);
      if (!all.length) return log("no successful runs yet. type run.");
      return log(
        `median of ${all.length}\n${table(medians(all.map((r) => r.baseline)), medians(all.map((r) => r.optimized)))}`,
      );
    }
    case "bench": {
      const arm = (rows: typeof recorded.control) =>
        medians(
          rows.map((r) => ({
            ...r,
            modelMs: r.modelDurationMs,
            toolMs: r.toolDurationMs,
            output: "",
            spans: [],
            facts: { found: 0, total: 0 },
          })),
        );
      return log(
        `recorded ${recorded.generatedAt.slice(0, 10)}, ${recorded.model}, ${recorded.control.length} runs per arm, medians\n${table(arm(recorded.control), arm(recorded.treatment))}`,
      );
    }
    case "reset":
      deleteRuns(user.id);
      emit({ type: "reset" });
      return log("your runs are deleted.");
    default:
      return log(`unknown command: ${command}. type help.`);
  }
}
