import "server-only";
import type { Run } from "@/lib/types";
import { bindings } from "./cloudflare";
import { readSavedRun } from "./saved-run";

export const db = () => bindings().DB;

export async function saveRun(userId: string, run: Run): Promise<void> {
  await db()
    .prepare("INSERT INTO runs (id, user_id, created_at, json) VALUES (?, ?, ?, ?)")
    .bind(run.id, userId, run.createdAt, JSON.stringify(run))
    .run();
}

/** Oldest first, newest 30. Always scoped to one user. */
export async function listRuns(userId: string): Promise<Run[]> {
  const { results } = await db()
    .prepare("SELECT json FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30")
    .bind(userId)
    .all<{ json: string }>();
  return results.flatMap((r) => readSavedRun(r.json) ?? []).reverse();
}

export async function deleteRuns(userId: string): Promise<void> {
  await db().prepare("DELETE FROM runs WHERE user_id = ?").bind(userId).run();
}

/** Counts one use of `what` against today's cap. False once the cap is reached. */
export async function takeToday(what: string, limit: number): Promise<boolean> {
  if (limit < 1) return false;
  const key = `${new Date().toISOString().slice(0, 10)}:${what}`;
  // One statement, so requests arriving together cannot both take the last place.
  const row = await db()
    .prepare(
      `INSERT INTO usage (key, count) VALUES (?, 1)
       ON CONFLICT (key) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(key, limit)
    .first<{ count: number }>();
  return row !== null;
}
