import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test, vi } from "vitest";

// D1 is SQLite, so the real migration and the real queries run on node:sqlite here.
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(import.meta.dirname, "../migrations/0001_init.sql"), "utf8"));
const statement = (sql: string, values: SQLInputValue[] = []) => ({
  bind: (...next: SQLInputValue[]) => statement(sql, next),
  first: async () => sqlite.prepare(sql).get(...values) ?? null,
  all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
  run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
});

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { DB: { prepare: (sql: string) => statement(sql) } } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => jar.set(k, v),
    delete: (k: string) => jar.delete(k),
  }),
  headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.7" }),
}));

const auth = await import("../src/lib/server/auth");
const store = await import("../src/lib/server/db");

const user = async (name: string, pin: string) => {
  const created = await auth.createUser(name, pin);
  if ("error" in created) throw new Error(created.error);
  return created;
};

test("credentials are validated", () => {
  expect(auth.validateCredentials("ege", "0000")).toBeNull();
  for (const [name, pin] of [
    ["Ege", "0000"],
    ["ab", "0000"],
    ["ege", "000"],
    ["ege", "12a4"],
  ] as const)
    expect(auth.validateCredentials(name, pin)).not.toBeNull();
});

test("sessions cannot be forged and results stay with their user", async () => {
  const a = await user("alice", "1111");
  const b = await user("bob", "2222");
  expect(await auth.createUser("alice", "3333")).toHaveProperty("error");
  const saved = { id: "r1", createdAt: 1, pricing: {}, baseline: {}, optimized: {} };
  await store.saveRun(a.id, saved as never);
  expect(await store.listRuns(b.id)).toEqual([]);
  await store.deleteRuns(b.id);
  expect(await store.listRuns(a.id)).toHaveLength(1);

  await auth.startSession(a.id);
  expect((await auth.currentUser())?.username).toBe("alice");
  const [, expires, mac] = jar.get("sdk_session")!.split(".");
  jar.set("sdk_session", `${b.id}.${expires}.${mac}`);
  expect(await auth.currentUser()).toBeNull();
});

test("five wrong pins lock the account, even against the right pin", async () => {
  await user("carol", "1234");
  for (let i = 0; i < 5; i++) expect(await auth.checkUser("carol", "0000")).toHaveProperty("error");
  expect(await auth.checkUser("carol", "1234")).toEqual({
    error: expect.stringContaining("too many attempts"),
  });
});

test("guesses sent together do not get past the lockout", async () => {
  await user("erin", "9999");
  const guesses = Array.from({ length: 40 }, (_, i) => String(i).padStart(4, "0"));
  await Promise.all(guesses.map((pin) => auth.checkUser("erin", pin)));
  expect(await auth.checkUser("erin", "9999")).toEqual({
    error: expect.stringContaining("too many attempts"),
  });
});

test("daily caps hold", async () => {
  const take = () => store.takeToday("runs", 2);
  expect([await take(), await take(), await take()]).toEqual([true, true, false]);
  const signUps = [];
  for (let i = 0; i < 11; i++) signUps.push(await auth.allowAddress("sign-up"));
  expect(signUps.filter(Boolean)).toHaveLength(10);
});

test("results saved by earlier versions load without crashing", async () => {
  const d = await user("dana", "4444");
  const arm = { output: "legacy carts: disable the flag" };
  const old = { id: "old", createdAt: 1, pricing: {}, baseline: arm, optimized: arm };
  await store.saveRun(d.id, old as never);
  await store.saveRun(d.id, {
    id: "simulated",
    createdAt: 2,
    baseline: arm,
    optimized: arm,
  } as never);
  const runs = await store.listRuns(d.id);
  expect(runs.map((r) => r.id)).toEqual(["old"]);
  expect(runs[0]?.optimized.facts).toEqual({ found: 2, total: 4 });

  const invented = { output: "made up", success: true, toolCalls: 0 };
  await store.saveRun(d.id, {
    id: "ungrounded",
    createdAt: 3,
    pricing: {},
    baseline: arm,
    optimized: invented,
  } as never);
  expect((await store.listRuns(d.id)).at(-1)?.optimized.success).toBe(false);
});
