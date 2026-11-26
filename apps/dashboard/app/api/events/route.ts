import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRuntimeEvent } from "@runto/protocol";

export async function GET() {
  const path = process.env.NAVO_EVENT_LOG ?? resolve(process.cwd(), "../../runtime-events.jsonl");
  try {
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean).slice(-200);
    const events = lines.flatMap((line) => {
      try {
        return [parseRuntimeEvent(JSON.parse(line))];
      } catch {
        return [];
      }
    });
    return Response.json(events);
  } catch {
    return Response.json([]);
  }
}
