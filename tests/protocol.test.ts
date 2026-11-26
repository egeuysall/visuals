import { createRuntimeEvent, parseRuntimeEvent, runtimeEventJsonSchema } from "@runto/protocol";
import { describe, expect, it } from "vitest";

describe("runtime event protocol", () => {
  it("keeps the Zod event shape strict and exposes matching JSON Schema requirements", () => {
    const event = createRuntimeEvent("run.started", { payload: { task: "smoke" } });
    expect(parseRuntimeEvent(event)).toEqual(event);
    expect(() => parseRuntimeEvent({ ...event, unexpected: true })).toThrow();
    const schema = runtimeEventJsonSchema();
    expect(schema.required).toEqual(
      expect.arrayContaining(["protocolVersion", "id", "type", "timestamp", "payload"]),
    );
    expect((schema.properties as Record<string, Record<string, unknown>>).error).toMatchObject({
      required: ["name", "message"],
    });
  });
});
