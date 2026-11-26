import type { WorkflowMemory } from "./types.js";

interface Workflow {
  task: string;
  toolIds: string[];
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_:-]+/g) ?? []);
}

/** Small local workflow memory. It learns successful tool sequences without storing prompts elsewhere. */
export class InMemoryWorkflowMemory implements WorkflowMemory {
  private readonly workflows: Workflow[] = [];

  record(task: string, toolIds: string[]): void {
    if (!task.trim() || !toolIds.length) return;
    const existing = this.workflows.find((workflow) => workflow.task === task);
    if (existing) existing.toolIds = [...toolIds];
    else this.workflows.push({ task, toolIds: [...toolIds] });
  }

  suggest(task: string, limit = 3): string[] {
    const query = terms(task);
    const ranked = this.workflows
      .map((workflow) => {
        const overlap = [...query].filter((term) => terms(workflow.task).has(term)).length;
        return { workflow, score: query.size ? overlap / query.size : 0 };
      })
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.workflow.task.localeCompare(right.workflow.task),
      );
    return [
      ...new Set(ranked.slice(0, Math.max(1, limit)).flatMap((item) => item.workflow.toolIds)),
    ];
  }

  clear(): void {
    this.workflows.length = 0;
  }
}
