export type PlanSideEffect = "none" | "read" | "write" | "irreversible";

export interface ToolPlanNode {
  id: string;
  toolId: string;
  input: unknown;
  dependsOn: string[];
  sideEffect?: PlanSideEffect;
}

export interface SchedulerOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  canRunTogether?: (left: ToolPlanNode, right: ToolPlanNode) => boolean;
  onGroupStart?: (nodes: ToolPlanNode[]) => void | Promise<void>;
  onGroupComplete?: (nodes: ToolPlanNode[]) => void | Promise<void>;
}

export interface ScheduleResult<T> {
  node: ToolPlanNode;
  value: T;
}

function abortError(): Error {
  return new DOMException("Operation aborted", "AbortError");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

async function runAttempt<T>(
  node: ToolPlanNode,
  execute: (node: ToolPlanNode, signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  parentSignal: AbortSignal | undefined,
): Promise<T> {
  if (parentSignal?.aborted) throw abortError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  let rejectAbort: (() => void) | undefined;
  const operation = Promise.resolve()
    .then(() => execute(node, controller.signal))
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
  operation.catch(() => undefined);
  const aborted = parentSignal
    ? new Promise<never>((_, reject) => {
        rejectAbort = () => {
          controller.abort(parentSignal.reason);
          reject(abortError());
        };
        parentSignal.addEventListener("abort", rejectAbort, { once: true });
      })
    : undefined;
  const timeout = timeoutMs
    ? new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Tool ${node.toolId} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    : undefined;
  try {
    return await Promise.race([operation, timeout, aborted].filter(Boolean) as Promise<T>[]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
    if (rejectAbort) parentSignal?.removeEventListener("abort", rejectAbort);
  }
}

export class DependencyScheduler {
  async run<T>(
    nodes: ToolPlanNode[],
    execute: (node: ToolPlanNode, signal: AbortSignal) => Promise<T>,
    options: SchedulerOptions = {},
  ): Promise<ScheduleResult<T>[]> {
    const maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    const retries = Math.max(0, options.retries ?? 0);
    const remaining = new Map(nodes.map((node) => [node.id, node]));
    const completed = new Map<string, ScheduleResult<T>>();
    if (remaining.size !== nodes.length) throw new Error("Tool plan contains duplicate node ids");
    for (const node of nodes) {
      for (const dependency of node.dependsOn) {
        if (!remaining.has(dependency))
          throw new Error(`Unknown dependency ${dependency} for ${node.id}`);
      }
    }

    while (remaining.size) {
      if (options.signal?.aborted) throw abortError();
      const ready = [...remaining.values()].filter((node) =>
        node.dependsOn.every((id) => completed.has(id)),
      );
      if (!ready.length) throw new Error("Tool plan contains a dependency cycle");
      const group: ToolPlanNode[] = [];
      const canRunTogether =
        options.canRunTogether ??
        ((left: ToolPlanNode, right: ToolPlanNode) => {
          const unsafe = new Set(["write", "irreversible"]);
          return !unsafe.has(left.sideEffect ?? "none") && !unsafe.has(right.sideEffect ?? "none");
        });
      for (const node of ready) {
        if (group.length >= maxConcurrency) break;
        if (group.every((other) => canRunTogether(other, node))) group.push(node);
        if (
          group.length === 1 &&
          (node.sideEffect === "write" || node.sideEffect === "irreversible")
        )
          break;
      }
      await options.onGroupStart?.(group);
      if (options.signal?.aborted) throw abortError();
      const groupController = new AbortController();
      const abortGroup = () => groupController.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abortGroup, { once: true });
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < group.length) {
          if (groupController.signal.aborted) throw abortError();
          const node = group[cursor++];
          if (!node) return;
          let lastError: unknown;
          const nodeRetries = ["none", "read"].includes(node.sideEffect ?? "none") ? retries : 0;
          for (let attempt = 0; attempt <= nodeRetries; attempt += 1) {
            try {
              const value = await runAttempt(
                node,
                execute,
                options.timeoutMs,
                groupController.signal,
              );
              const result = { node, value };
              completed.set(node.id, result);
              remaining.delete(node.id);
              return;
            } catch (error) {
              lastError = error;
              if (options.signal?.aborted) throw error;
              if (groupController.signal.aborted) throw error;
              if (attempt < nodeRetries)
                await sleep(options.retryDelayMs ?? 50, groupController.signal);
            }
          }
          const error = lastError instanceof Error ? lastError : new Error(String(lastError));
          groupController.abort(error);
          throw error;
        }
      };
      try {
        await Promise.all(
          Array.from({ length: Math.min(maxConcurrency, group.length) }, () => worker()),
        );
        await options.onGroupComplete?.(group);
      } finally {
        options.signal?.removeEventListener("abort", abortGroup);
      }
    }
    return nodes.map((node) => completed.get(node.id) as ScheduleResult<T>);
  }
}

export function createScheduler(): DependencyScheduler {
  return new DependencyScheduler();
}
