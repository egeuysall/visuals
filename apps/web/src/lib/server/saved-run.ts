import "server-only";
import type { Run } from "@/lib/types";
import { factCheck } from "./scenario";

/**
 * Reads a stored result, including ones saved by earlier versions. Results with no pricing came
 * from the old simulated model and are not shown. A missing answer check is worked out again.
 */
export function readSavedRun(json: string): Run | null {
  const run = JSON.parse(json) as Run;
  if (!run.pricing || !run.baseline || !run.optimized) return null;
  for (const arm of [run.baseline, run.optimized]) {
    arm.facts ??= factCheck(arm.output ?? "");
    // Saved before lookups were required: an answer with none has no basis, so it never counts.
    if (arm.toolCalls === 0) arm.success = false;
  }
  return run;
}
