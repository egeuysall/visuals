import { createScheduler, type ToolPlanNode } from "@runto/scheduler";
import { describe, expect, it } from "vitest";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DependencyScheduler", () => {
  it("times out attempts, aborts work, and observes late rejection", async () => {
    const scheduler = createScheduler();
    let aborted = false;

    await expect(
      scheduler.run(
        [{ id: "slow", toolId: "slow", input: null, dependsOn: [], sideEffect: "read" }],
        async (_node, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              setTimeout(() => reject(new Error("late failure")), 1);
            });
          }),
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow("Tool slow timed out after 1ms");

    await tick(5);
    expect(aborted).toBe(true);
  });

  it("propagates parent cancellation to the active attempt", async () => {
    const scheduler = createScheduler();
    const controller = new AbortController();
    let attemptAborted = false;

    const run = scheduler.run(
      [{ id: "read", toolId: "read", input: null, dependsOn: [], sideEffect: "read" }],
      async (_node, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            attemptAborted = true;
          });
          controller.abort();
        }),
      { signal: controller.signal },
    );

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(attemptAborted).toBe(true);
  });

  it("retries only safe nodes, bounds groups, and returns input order", async () => {
    const scheduler = createScheduler();
    const nodes: ToolPlanNode[] = [
      { id: "b", toolId: "b", input: null, dependsOn: [], sideEffect: "read" },
      { id: "a", toolId: "a", input: null, dependsOn: [], sideEffect: "none" },
      { id: "write", toolId: "write", input: null, dependsOn: ["a", "b"], sideEffect: "write" },
    ];
    const attempts = new Map<string, number>();
    const starts: string[][] = [];
    const completes: string[][] = [];
    let running = 0;
    let maxRunning = 0;

    const results = await scheduler.run(
      nodes,
      async (node) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        attempts.set(node.id, (attempts.get(node.id) ?? 0) + 1);
        await tick(1);
        running -= 1;
        if (node.id === "a" && attempts.get(node.id) === 1) throw new Error("retry me");
        return node.id;
      },
      {
        maxConcurrency: 2,
        retries: 1,
        retryDelayMs: 0,
        onGroupStart: (group) => {
          starts.push(group.map((node) => node.id));
        },
        onGroupComplete: (group) => {
          completes.push(group.map((node) => node.id));
        },
      },
    );

    expect(results.map((result) => result.value)).toEqual(["b", "a", "write"]);
    expect(attempts.get("a")).toBe(2);
    expect(attempts.get("write")).toBe(1);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(starts).toEqual([["b", "a"], ["write"]]);
    expect(completes).toEqual(starts);

    await expect(
      scheduler.run(
        [{ id: "write", toolId: "write", input: null, dependsOn: [], sideEffect: "write" }],
        async () => {
          attempts.set("unsafe-write", (attempts.get("unsafe-write") ?? 0) + 1);
          throw new Error("do not retry");
        },
        { retries: 1, retryDelayMs: 0 },
      ),
    ).rejects.toThrow("do not retry");
    expect(attempts.get("unsafe-write")).toBe(1);
  });
});
