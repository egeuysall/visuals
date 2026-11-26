export interface ContextItem {
  id?: string;
  text: string;
  source: string;
  updatedAt?: string;
  confidence?: number;
  authorized?: boolean;
  sensitive?: boolean;
  conflictKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextFact {
  text: string;
  source: string;
  updatedAt?: string;
  confidence: number;
}

export interface ContextPacket {
  facts: ContextFact[];
  conflicts: Array<{ claim: string; sources: string[] }>;
  excluded: Array<{
    source: string;
    reason: "permission" | "stale" | "duplicate" | "low-relevance";
  }>;
  tokenCount: number;
}

export interface ContextCompiler {
  compile(input: ContextCompileInput): Promise<ContextPacket> | ContextPacket;
}

export interface ContextCompileInput {
  task: string;
  items: ContextItem[];
  tokenBudget: number;
  now?: number;
  staleAfterMs?: number;
  minRelevance?: number;
  redact?: RegExp[];
  rank?: (item: ContextItem, task: string) => number;
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_:-]+/g) ?? []);
}

function relevance(item: ContextItem, task: string): number {
  const taskTerms = terms(task);
  const itemTerms = terms(item.text);
  const overlap = [...taskTerms].filter((term) => itemTerms.has(term)).length;
  const relevanceScore = taskTerms.size ? overlap / taskTerms.size : 0;
  return relevanceScore * 0.75 + Math.min(1, Math.max(0, item.confidence ?? 0.5)) * 0.25;
}

export class DeterministicContextCompiler implements ContextCompiler {
  compile(input: ContextCompileInput): ContextPacket {
    const now = input.now ?? Date.now();
    const excluded: ContextPacket["excluded"] = [];
    const accepted: Array<{ item: ContextItem; text: string; score: number }> = [];
    const seen = new Set<string>();

    for (const item of input.items) {
      if (item.authorized === false) {
        excluded.push({ source: item.source, reason: "permission" });
        continue;
      }
      if (input.staleAfterMs !== undefined && item.updatedAt) {
        const age = now - Date.parse(item.updatedAt);
        if (Number.isFinite(age) && age > input.staleAfterMs) {
          excluded.push({ source: item.source, reason: "stale" });
          continue;
        }
      }
      const text = normalize(item.text);
      if (!text) continue;
      const redacted = (input.redact ?? []).reduce(
        (value, expression) => value.replace(expression, "[redacted]"),
        text,
      );
      const key = redacted.toLowerCase();
      if (seen.has(key)) {
        excluded.push({ source: item.source, reason: "duplicate" });
        continue;
      }
      seen.add(key);
      const score =
        input.rank?.({ ...item, text: redacted }, input.task) ??
        relevance({ ...item, text: redacted }, input.task);
      if (score < (input.minRelevance ?? 0)) {
        excluded.push({ source: item.source, reason: "low-relevance" });
        continue;
      }
      accepted.push({ item, text: redacted, score });
    }

    accepted.sort(
      (left, right) =>
        right.score - left.score || left.item.source.localeCompare(right.item.source),
    );
    const facts: ContextFact[] = [];
    let tokenCount = 0;
    for (const candidate of accepted) {
      const cost = estimateTokens(candidate.text);
      if (tokenCount + cost > input.tokenBudget) {
        excluded.push({ source: candidate.item.source, reason: "low-relevance" });
        continue;
      }
      facts.push({
        text: candidate.text,
        source: candidate.item.source,
        ...(candidate.item.updatedAt ? { updatedAt: candidate.item.updatedAt } : {}),
        confidence: Math.max(0, Math.min(1, candidate.item.confidence ?? candidate.score)),
      });
      tokenCount += cost;
    }

    const groups = new Map<string, ContextFact[]>();
    for (const fact of facts) {
      const sourceItem = input.items.find(
        (item) => item.source === fact.source && item.text.trim() === fact.text,
      );
      const key = sourceItem?.conflictKey;
      if (key) groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    const conflicts = [...groups.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([claim, group]) => ({ claim, sources: group.map((fact) => fact.source) }));

    return { facts, conflicts, excluded, tokenCount };
  }
}

export function compileContext(input: ContextCompileInput): ContextPacket {
  return new DeterministicContextCompiler().compile(input);
}
