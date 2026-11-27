import "server-only";
import { randomUUID } from "node:crypto";
import type { Kaibo } from "kaibo";
import recorded from "@/data/recorded-benchmark.json";
import { median, ratio } from "@/lib/stats";
import type { ArmName, ArmResult, Levers, Run, StreamEvent } from "@/lib/types";
import { runArm } from "./agent";
import type { User } from "./auth";
import { deleteRuns, listRuns, saveRun, takeToday } from "./db";
import { memoryFor } from "./memory";
import { DEFAULT_TASK, incidentSources } from "./scenario";
import { modelName, pricing } from "./workers-ai";

const HELP = `type a question and press enter. the ai answers it twice and compares.

compare              run the sample question
remember "fact"      save something about you
recall "question"    ask what has been saved
my results           your typical numbers so far
earlier test         results from a longer test
reset                delete your results (saved facts stay)
clear                clear this screen`;

const MEMORY_OFF = "memory is not set up yet.";
const MEMORY_DOWN = "memory isn't available right now.";

type Emit = (event: StreamEvent) => void;

/** Splits a line into words, keeping quoted strings together. */
export function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

const times = (before: number, after: number) => {
  const r = ratio(before, after);
  return r === null ? "n/a" : `${r.toFixed(1)}x`;
};

function table(
  base: Omit<ArmResult, "output" | "spans" | "success" | "facts">,
  opt: typeof base,
): string {
  const secs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
  const whole = (n: number) => Math.round(n).toLocaleString("en-US");
  const rows: [string, number, number, (n: number) => string][] = [
    ["total time", base.latencyMs, opt.latencyMs, secs],
    ["looking things up", base.toolMs, opt.toolMs, secs],
    ["text read", base.inputTokens, opt.inputTokens, whole],
    ["text written", base.outputTokens, opt.outputTokens, whole],
    ["cost", base.costUsd, opt.costUsd, (n) => `$${n.toFixed(5)}`],
  ];
  return [
    `${"".padEnd(18)}${"standard".padStart(10)}${"optimized".padStart(11)}${"ratio".padStart(7)}`,
    ...rows.map(
      ([label, a, b, f]) =>
        `${label.padEnd(18)}${f(a).padStart(10)}${f(b).padStart(11)}${times(a, b).padStart(7)}`,
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

/** Keeps service errors in the server log and out of what people read. */
const logError = (what: string, error: unknown) =>
  console.error(what, error instanceof Error ? error.message : error);

/** Swaps typographic arrows and long dashes in an answer for ordinary words and commas. */
const tidy = (text: string) =>
  text
    .replace(/\\(?=_)/g, "")
    .replace(/\s*\u2192\s*/g, " to ")
    .replace(/\s*\u2014\s*/g, ", ")
    .trim();

async function readMemory(
  memory: Kaibo | null,
  task: string,
): Promise<{ state: Run["memory"]; text: string; note: string }> {
  if (!memory) return { state: "off", text: "", note: "" };
  try {
    const pack = await memory.recall(task);
    if (!pack.found) return { state: "empty", text: "", note: "" };
    return {
      state: "used",
      text: await memory.context(task),
      note: "using what you've saved before.",
    };
  } catch (error) {
    logError("memory read failed", error);
    return { state: "error", text: "", note: `${MEMORY_DOWN} continuing without it.` };
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

  if (running.has(user.id)) return log("one question at a time. the last one is still running.");
  running.add(user.id);
  try {
    if (!(await takeToday(`runs:${user.id}`, Number(process.env.USER_RUNS_PER_DAY || 20))))
      return log("you've reached today's limit. come back tomorrow.");
    if (!(await takeToday("runs", Number(process.env.LIVE_RUNS_PER_DAY || 200))))
      return log("the site has reached today's limit. come back tomorrow.");

    const memory = memoryFor(user.id);
    const recalled = await readMemory(memory, task);
    if (recalled.note) log(recalled.note);

    const input = recalled.text ? `${task}\n\n${recalled.text}` : task;

    // One at a time, so neither slows the other down. The optimized way goes first and its answer
    // is shown straight away: nobody has to sit through the slow one to read it.
    log("getting your answer.");
    const answer = async (arm: ArmName, label: string) => {
      const r = await runArm(
        arm,
        input,
        levers,
        AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      );
      if (r.error) logError(`${arm} run failed`, r.error);
      const time = `${(r.latencyMs / 1000).toFixed(1)}s`;
      if (r.success) log(`${label} way: done in ${time}`);
      else if (r.error) log(`${label} way: did not finish after ${time}.`);
      else if (!r.toolCalls) log(`${label} way: answered without looking anything up.`);
      else log(`${label} way: gave no answer.`);
      return r;
    };
    const optimized = await answer("optimized", "optimized");
    if (optimized.success) emit({ type: "answer", text: tidy(optimized.output) });
    signal.throwIfAborted();
    log("now timing the standard way to compare. it often takes 20 to 60 seconds.");
    const baseline = await answer("baseline", "standard");
    const results = { baseline, optimized };

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
    await saveRun(user.id, result);
    emit({ type: "run", run: result });
    const ok = result.baseline.success && result.optimized.success;
    if (!ok)
      log(
        "this one can't be compared fairly, so it is left out of your results. please try again.",
      );
    else {
      const { baseline, optimized } = result;
      log(`\n${table(baseline, optimized)}`);
      log(
        `key facts found in the answer: standard ${baseline.facts.found} of ${baseline.facts.total}, optimized ${optimized.facts.found} of ${optimized.facts.total}`,
      );
      if (baseline.toolCalls !== optimized.toolCalls)
        log(
          `heads up: standard checked ${baseline.toolCalls} sources and optimized checked ${optimized.toolCalls}, so this is not an exact match.`,
        );
    }
    // Already shown above unless only the standard way produced an answer.
    if (!result.optimized.success && result.baseline.success)
      emit({ type: "answer", text: tidy(result.baseline.output) });

    // Only what the user asked is stored: model output is not treated as a fact.
    if (memory && words.length) {
      try {
        await memory.remember(`The user asked the incident agent: ${task}`);
      } catch (error) {
        logError("memory write failed", error);
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
  const alias: Record<string, string> = {
    compare: "run",
    "my results": "stats",
    "earlier test": "bench",
  };
  let words = tokenize(alias[line.toLowerCase()] ?? line);
  if (words[0] === "sdk") words = words.slice(1);
  const [command = "help", ...args] = words;
  const text = args.join(" ").trim();

  switch (command.toLowerCase()) {
    case "help":
    case "--help":
      return log(HELP);
    case "run":
      return run(user, args, emit, signal);
    case "tools":
      return log(incidentSources.map((s) => s.description).join("\n"));
    case "remember":
    case "recall": {
      if (!text) return log(`add some text, like: ${command} "..."`);
      if (text.length > 2_000) return log("keep it under 2000 characters.");
      const memory = memoryFor(user.id);
      if (!memory) return log(MEMORY_OFF);
      // Memory calls cost money too, so they are capped per account and for the whole site.
      if (!(await takeToday(`memory:${user.id}`, 50)) || !(await takeToday("memory", 1_000)))
        return log("that's enough memory for today. come back tomorrow.");
      try {
        if (command === "remember") {
          await memory.remember(text, { wait: true });
          return log("saved.");
        }
        const pack = await memory.recall(text);
        return log(pack.found ? String(pack.answer) : "nothing saved about that yet.");
      } catch (error) {
        logError("memory command failed", error);
        return log(MEMORY_DOWN);
      }
    }
    case "stats": {
      const all = (await listRuns(user.id)).filter(
        (r) => r.baseline.success && r.optimized.success,
      );
      if (!all.length) return log("no results yet. press compare to start.");
      return log(
        `your typical result over ${all.length}\n${table(medians(all.map((r) => r.baseline)), medians(all.map((r) => r.optimized)))}`,
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
        `an earlier test, ${recorded.control.length} tries each way, typical result\n${table(arm(recorded.control), arm(recorded.treatment))}`,
      );
    }
    case "reset":
      await deleteRuns(user.id);
      emit({ type: "reset" });
      return log("your results are deleted.");
    default:
      // Anything that reads like a question is one. A stray word is not worth a minute of waiting.
      if (line.endsWith("?") || words.length >= 3) return run(user, [line], emit, signal);
      return log("not sure what you mean. ask a full question, or type help.");
  }
}
