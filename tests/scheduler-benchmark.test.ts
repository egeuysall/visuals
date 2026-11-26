import { runBenchmark } from "@runto/benchmark";
import { createScheduler } from "@runto/scheduler";
import { describe, expect, it } from "vitest";

describe("scheduler and benchmark", () => {
  it("parallelizes reads but serializes writes", async () => {
    const scheduler = createScheduler();
    const order: string[] = [];
    const results = await scheduler.run(
      [
        { id: "read-a", toolId: "a", input: null, dependsOn: [], sideEffect: "read" },
        { id: "read-b", toolId: "b", input: null, dependsOn: [], sideEffect: "read" },
        {
          id: "write",
          toolId: "write",
          input: null,
          dependsOn: ["read-a", "read-b"],
          sideEffect: "write",
        },
      ],
      async (node) => {
        order.push(node.id);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return node.id;
      },
      {
        maxConcurrency: 2,
        canRunTogether: (left, right) =>
          ![left.sideEffect, right.sideEffect].some(
            (effect) => effect === "write" || effect === "irreversible",
          ),
      },
    );
    expect(results.map((result) => result.value)).toEqual(["read-a", "read-b", "write"]);
    expect(order.at(-1)).toBe("write");
  });

  it("reports cost per successful task at the required p95 latency", async () => {
    const result = await runBenchmark({
      tasks: [
        { id: "one", task: "one", requiredP95LatencyMs: 100, success: (output) => output === "ok" },
      ],
      control: async () => ({ output: "ok", latencyMs: 80, costUsd: 0.02, success: true }),
      treatment: async () => ({ output: "ok", latencyMs: 20, costUsd: 0.01, success: true }),
    });
    expect(result.treatment.costPerSuccessfulTaskUsd).toBe(0.01);
    expect(result.treatmentMeetsRequiredP95).toBe(true);
  });

  it("runs paired attempts serially and alternates order by task", async () => {
    const order: string[] = [];
    await runBenchmark({
      tasks: [
        { id: "one", task: "one", success: () => true },
        { id: "two", task: "two", success: () => true },
      ],
      control: async (task) => {
        order.push(`control:${task.id}`);
        return { output: "ok", latencyMs: 1, costUsd: 0, success: true };
      },
      treatment: async (task) => {
        order.push(`treatment:${task.id}`);
        return { output: "ok", latencyMs: 1, costUsd: 0, success: true };
      },
    });
    expect(order).toEqual(["control:one", "treatment:one", "treatment:two", "control:two"]);
  });
});
