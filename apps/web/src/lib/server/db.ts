import "server-only";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Run } from "@/lib/types";
import { dataDir } from "./data-dir";

const store = globalThis as { visualsDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (store.visualsDb) return store.visualsDb;
  const d = new DatabaseSync(join(dataDir(), "visuals.db"));
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL, salt TEXT NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_user ON runs (user_id, created_at);
    CREATE TABLE IF NOT EXISTS live_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
  `);
  store.visualsDb = d;
  return d;
}

export function saveRun(userId: string, run: Run): void {
  db()
    .prepare("INSERT INTO runs (id, user_id, created_at, json) VALUES (?, ?, ?, ?)")
    .run(run.id, userId, run.createdAt, JSON.stringify(run));
}

/** Oldest first, newest 30. Always scoped to one user. */
export function listRuns(userId: string): Run[] {
  const rows = db()
    .prepare("SELECT json FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30")
    .all(userId) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as Run).reverse();
}

export function deleteRuns(userId: string): void {
  db().prepare("DELETE FROM runs WHERE user_id = ?").run(userId);
}

/** Counts one live run against today's cap across all users. False when the cap is reached. */
export function takeLiveRun(limit: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  db().prepare("INSERT OR IGNORE INTO live_usage (day, count) VALUES (?, 0)").run(day);
  const r = db()
    .prepare("UPDATE live_usage SET count = count + 1 WHERE day = ? AND count < ?")
    .run(day, limit);
  return Number(r.changes) === 1;
}
