import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export type CachePolicy =
  | { mode: "never" }
  | { mode: "ttl"; ttlMs: number }
  | { mode: "versioned"; versionField: string }
  | { mode: "validate-before-use" };

export interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  expiresAt?: number;
  version?: string;
}

export interface CacheAdapter {
  get<T = unknown>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T = unknown>(key: string, entry: CacheEntry<T>): Promise<void>;
  delete?(key: string): Promise<void>;
  clear?(): Promise<void>;
}

export class MemoryCacheAdapter implements CacheAdapter {
  private readonly values = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 10_000) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const value = this.values.get(key) as CacheEntry<T> | undefined;
    if (value) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    if (!this.values.has(key) && this.values.size >= Math.max(1, this.maxEntries))
      this.values.delete(this.values.keys().next().value as string);
    this.values.delete(key);
    this.values.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

export class FileCacheAdapter implements CacheAdapter {
  private readonly file: string;
  private readonly maxEntries: number;
  private loaded = false;
  private readonly values = new Map<string, CacheEntry>();

  constructor(directory = ".aar-cache", maxEntries = 10_000) {
    this.file = join(directory, "cache.json");
    this.maxEntries = Math.max(1, maxEntries);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const contents = await readFile(this.file, "utf8");
      let changed = false;
      const now = Date.now();
      for (const [key, value] of Object.entries(
        JSON.parse(contents) as Record<string, CacheEntry>,
      )) {
        if (value.expiresAt !== undefined && value.expiresAt <= now) {
          changed = true;
          continue;
        }
        this.values.set(key, value);
      }
      while (this.values.size > this.maxEntries) {
        this.values.delete(this.values.keys().next().value as string);
        changed = true;
      }
      if (changed) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    // ponytail: whole-file JSON persistence; use SQLite for concurrent multi-process writes.
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.values)), "utf8");
    await rename(temporary, this.file);
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    await this.load();
    const value = this.values.get(key) as CacheEntry<T> | undefined;
    if (value?.expiresAt !== undefined && value.expiresAt <= Date.now()) {
      this.values.delete(key);
      await this.persist();
      return undefined;
    }
    if (value) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await this.load();
    this.values.delete(key);
    while (this.values.size >= this.maxEntries)
      this.values.delete(this.values.keys().next().value as string);
    this.values.set(key, entry);
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    this.values.delete(key);
    await this.persist();
  }

  async clear(): Promise<void> {
    this.values.clear();
    this.loaded = true;
    await this.persist();
  }
}

/**
 * Synchronous SQLite is a good local cache boundary: one process, durable,
 * crash-safe writes, and no native dependency. Use Redis/Convex for shared
 * multi-process deployments.
 */
export class SqliteCacheAdapter implements CacheAdapter {
  private readonly database: InstanceType<typeof DatabaseSync>;
  private readonly maxEntries: number;

  constructor(file = ".aar-cache/cache.sqlite", maxEntries = 10_000) {
    mkdirSync(dirname(file), { recursive: true });
    this.maxEntries = Math.max(1, maxEntries);
    this.database = new DatabaseSync(file);
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, version TEXT)",
    );
  }

  private pruneExpired(): void {
    this.database
      .prepare("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(Date.now());
  }

  private enforceLimit(): void {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM cache").get() as {
      count: number;
    };
    const excess = count.count - this.maxEntries;
    if (excess > 0)
      this.database
        .prepare(
          "DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY created_at ASC LIMIT ?)",
        )
        .run(excess);
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    this.pruneExpired();
    this.enforceLimit();
    const row = this.database
      .prepare("SELECT value, created_at, expires_at, version FROM cache WHERE key = ?")
      .get(key) as
      | { value: string; created_at: number; expires_at: number | null; version: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      value: JSON.parse(row.value) as T,
      createdAt: row.created_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.version === null ? {} : { version: row.version }),
    };
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.pruneExpired();
    this.enforceLimit();
    const exists = this.database.prepare("SELECT 1 FROM cache WHERE key = ?").get(key);
    if (!exists) {
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM cache").get() as {
        count: number;
      };
      if (count.count >= this.maxEntries)
        this.database
          .prepare(
            "DELETE FROM cache WHERE key = (SELECT key FROM cache ORDER BY created_at ASC LIMIT 1)",
          )
          .run();
    }
    this.database
      .prepare(
        "INSERT INTO cache (key, value, created_at, expires_at, version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at, version = excluded.version",
      )
      .run(
        key,
        JSON.stringify(entry.value),
        entry.createdAt,
        entry.expiresAt ?? null,
        entry.version ?? null,
      );
  }

  async delete(key: string): Promise<void> {
    this.database.prepare("DELETE FROM cache WHERE key = ?").run(key);
  }

  async clear(): Promise<void> {
    this.database.exec("DELETE FROM cache");
  }

  close(): void {
    this.database.close();
  }
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  del?(key: string): Promise<unknown>;
}

export class RedisCacheAdapter implements CacheAdapter {
  constructor(private readonly client: RedisLikeClient) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const value = await this.client.get(key);
    return value ? (JSON.parse(value) as CacheEntry<T>) : undefined;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const ttl = entry.expiresAt ? Math.max(1, entry.expiresAt - Date.now()) : undefined;
    await this.client.set(key, JSON.stringify(entry), ttl ? { PX: ttl } : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.client.del?.(key);
  }
}
