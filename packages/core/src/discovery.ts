import type {
  DiscoveryStrategy,
  EmbeddingProvider,
  LearnedToolRanker,
  RuntimeTool,
  ToolRegistry,
  ToolSummary,
} from "./types.js";

export type { EmbeddingProvider, LearnedToolRanker } from "./types.js";

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_:-]+/g) ?? [];
}

function searchText(tool: RuntimeTool): string {
  const properties = Object.keys(
    (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
  );
  return [
    tool.id,
    tool.name,
    tool.description,
    tool.metadata.server,
    ...properties,
    ...(tool.metadata.examples ?? []).map((example) => JSON.stringify(example)),
  ]
    .filter(Boolean)
    .join(" ");
}

function keywordScore(query: string, tool: RuntimeTool): number {
  const queryTerms = new Set(tokenize(query));
  const document = tokenize(searchText(tool));
  if (!queryTerms.size || !document.length) return 0;
  const matches = document.filter((term) => queryTerms.has(term)).length;
  const phraseBonus = searchText(tool).toLowerCase().includes(query.toLowerCase()) ? 0.4 : 0;
  return matches / Math.max(1, queryTerms.size) + phraseBonus;
}

function bm25Scores(query: string, tools: RuntimeTool[]): Map<string, number> {
  const queryTerms = tokenize(query);
  const documents = tools.map((tool) => tokenize(searchText(tool)));
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document))
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const scores = new Map<string, number>();
  documents.forEach((document, index) => {
    const counts = new Map<string, number>();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = counts.get(term) ?? 0;
      if (!frequency) continue;
      const idf = Math.log(
        1 +
          (tools.length - (documentFrequency.get(term) ?? 0) + 0.5) /
            ((documentFrequency.get(term) ?? 0) + 0.5),
      );
      const numerator = frequency * 2.2;
      const denominator =
        frequency + 1.2 * (0.8 + 0.2 * (document.length / Math.max(1, averageLength)));
      score += idf * (numerator / denominator);
    }
    const tool = tools[index];
    if (tool)
      scores.set(
        tool.id,
        score + (searchText(tool).toLowerCase().includes(query.toLowerCase()) ? 0.4 : 0),
      );
  });
  return scores;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly byId = new Map<string, RuntimeTool>();
  private readonly embeddings = new Map<string, number[]>();

  constructor(
    tools: RuntimeTool[] = [],
    private readonly options: {
      embeddingProvider?: EmbeddingProvider;
      learnedToolRanker?: LearnedToolRanker;
    } = {},
  ) {
    for (const tool of tools) this.add(tool);
  }

  list(): RuntimeTool[] {
    return [...this.byId.values()];
  }

  get(id: string): RuntimeTool | undefined {
    return this.byId.get(id);
  }

  add(tool: RuntimeTool): void {
    if (this.byId.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    this.byId.set(tool.id, tool);
    this.embeddings.delete(tool.id);
  }

  search(
    query: string,
    options: { strategy?: DiscoveryStrategy; topK?: number } = {},
  ): ToolSummary[] {
    const tools = this.list();
    const strategy = options.strategy ?? "bm25";
    const scores =
      strategy === "bm25" ||
      strategy === "hybrid" ||
      strategy === "embedding" ||
      strategy === "learned"
        ? bm25Scores(query, tools)
        : new Map(tools.map((tool) => [tool.id, keywordScore(query, tool)]));
    return tools
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        ...(tool.metadata.server ? { server: tool.metadata.server } : {}),
        sideEffect: tool.metadata.sideEffect,
        score: scores.get(tool.id) ?? 0,
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, options.topK ?? 5));
  }

  async searchAsync(
    query: string,
    options: { strategy?: DiscoveryStrategy; topK?: number } = {},
  ): Promise<ToolSummary[]> {
    const strategy = options.strategy ?? "bm25";
    const tools = this.list();
    if (strategy === "learned" && this.options.learnedToolRanker) {
      const ranked = await this.options.learnedToolRanker.rank(query, tools);
      const scores = new Map(ranked.map((item) => [item.toolId, item.score]));
      return this.summaries(tools, scores, options.topK);
    }
    if ((strategy === "embedding" || strategy === "hybrid") && this.options.embeddingProvider) {
      const queryVector = await this.options.embeddingProvider.embed(query);
      const vectors = await Promise.all(
        tools.map(async (tool) => {
          const cached = this.embeddings.get(tool.id);
          if (cached) return [tool.id, cached] as const;
          const vector = await this.options.embeddingProvider?.embed(searchText(tool));
          if (vector) this.embeddings.set(tool.id, vector);
          return [tool.id, vector ?? []] as const;
        }),
      );
      const embeddingScores = new Map(
        vectors.map(([id, vector]) => [id, cosine(queryVector, vector)]),
      );
      if (strategy === "embedding") return this.summaries(tools, embeddingScores, options.topK);
      const keywordScores = bm25Scores(query, tools);
      const scores = new Map(
        tools.map((tool) => [
          tool.id,
          (keywordScores.get(tool.id) ?? 0) + (embeddingScores.get(tool.id) ?? 0),
        ]),
      );
      return this.summaries(tools, scores, options.topK);
    }
    return this.search(query, options);
  }

  private summaries(tools: RuntimeTool[], scores: Map<string, number>, topK = 5): ToolSummary[] {
    return tools
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        ...(tool.metadata.server ? { server: tool.metadata.server } : {}),
        sideEffect: tool.metadata.sideEffect,
        score: scores.get(tool.id) ?? 0,
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, topK));
  }
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
}

export function createToolRegistry(
  tools: RuntimeTool[] = [],
  options: { embeddingProvider?: EmbeddingProvider; learnedToolRanker?: LearnedToolRanker } = {},
): InMemoryToolRegistry {
  return new InMemoryToolRegistry(tools, options);
}

export function searchTools(
  tools: RuntimeTool[],
  query: string,
  options: { strategy?: DiscoveryStrategy; topK?: number } = {},
): ToolSummary[] {
  return createToolRegistry(tools).search(query, options);
}
