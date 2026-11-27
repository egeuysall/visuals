import "server-only";
import { Kaibo } from "kaibo";

/**
 * kaibo memory for one signed-in user, or null when no key is configured. `userId` must come from
 * the session: kaibo isolates memory by it.
 */
export function memoryFor(userId: string): Kaibo | null {
  const apiKey = process.env.KAIBO_KEY;
  if (!apiKey) return null;
  return new Kaibo({
    apiKey,
    baseUrl: process.env.KAIBO_URL || "https://kaibo.egeuysal.com",
    timeoutMs: 20_000,
    // Needed with an organization wide key, which must say which project a call is about.
    project: process.env.KAIBO_PROJECT || undefined,
  }).withUser(`visuals:${userId}`);
}
