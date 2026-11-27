import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The parts of the Cloudflare bindings this app uses. See wrangler.jsonc. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Bindings {
  DB: { prepare(sql: string): D1Statement };
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

export const bindings = () => getCloudflareContext().env as unknown as Bindings;
