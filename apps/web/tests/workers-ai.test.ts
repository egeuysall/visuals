import { expect, test, vi } from "vitest";

const replies: unknown[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { AI: { run: async () => replies.shift() } } }),
}));

const { workersAiProvider } = await import("../src/lib/server/workers-ai");

const reply = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
const ask = () =>
  workersAiProvider(true).generate({ messages: [{ role: "user", content: "hi" }], tools: [] });

test("an empty reply is tried once more, and both attempts are paid for", async () => {
  replies.push(reply(""), reply("done"));
  const result = await ask();
  expect(result.text).toBe("done");
  expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
});

test("it gives up after the second empty reply", async () => {
  replies.push(reply(""), reply(""), reply("never read"));
  expect((await ask()).text).toBe("");
  expect(replies).toHaveLength(1);
});
