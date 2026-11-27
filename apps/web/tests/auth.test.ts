import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => jar.set(k, v),
    delete: (k: string) => jar.delete(k),
  }),
}));
process.env.VISUALS_DATA_DIR = mkdtempSync(join(tmpdir(), "visuals-test-"));

const auth = await import("../src/lib/server/auth");
const store = await import("../src/lib/server/db");

const user = (r: ReturnType<typeof auth.createUser>) => {
  if ("error" in r) throw new Error(r.error);
  return r;
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

test("sessions cannot be forged and runs stay with their user", async () => {
  const a = user(auth.createUser("alice", "1111"));
  const b = user(auth.createUser("bob", "2222"));
  expect(auth.createUser("alice", "3333")).toHaveProperty("error");
  const saved = { id: "r1", createdAt: 1, pricing: {}, baseline: {}, optimized: {} };
  store.saveRun(a.id, saved as never);
  expect(store.listRuns(b.id)).toEqual([]);
  store.deleteRuns(b.id);
  expect(store.listRuns(a.id)).toHaveLength(1);

  await auth.startSession(a.id);
  expect((await auth.currentUser())?.username).toBe("alice");
  const [, expires, mac] = jar.get("visuals_session")!.split(".");
  jar.set("visuals_session", `${b.id}.${expires}.${mac}`);
  expect(await auth.currentUser()).toBeNull();
});

test("five wrong pins lock the account, even against the right pin", () => {
  user(auth.createUser("carol", "1234"));
  for (let i = 0; i < 5; i++) expect(auth.checkUser("carol", "0000")).toHaveProperty("error");
  expect(auth.checkUser("carol", "1234")).toEqual({
    error: expect.stringContaining("too many attempts"),
  });
});

test("the daily live cap holds", () => {
  expect([store.takeLiveRun(2), store.takeLiveRun(2), store.takeLiveRun(2)]).toEqual([
    true,
    true,
    false,
  ]);
});

test("results saved by earlier versions load without crashing", () => {
  const d = user(auth.createUser("dana", "4444"));
  const arm = { output: "legacy carts: disable the flag" };
  const old = { id: "old", createdAt: 1, pricing: {}, baseline: arm, optimized: arm };
  store.saveRun(d.id, old as never);
  store.saveRun(d.id, { id: "simulated", createdAt: 2, baseline: arm, optimized: arm } as never);
  const runs = store.listRuns(d.id);
  expect(runs.map((r) => r.id)).toEqual(["old"]);
  expect(runs[0]?.optimized.facts).toEqual({ found: 2, total: 4 });

  const invented = { output: "made up", success: true, toolCalls: 0 };
  store.saveRun(d.id, {
    id: "ungrounded",
    createdAt: 3,
    pricing: {},
    baseline: arm,
    optimized: invented,
  } as never);
  expect(store.listRuns(d.id).at(-1)?.optimized.success).toBe(false);
});
