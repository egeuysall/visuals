import { interpretedValidator } from "@runto/core";
import { expect, test } from "vitest";

// Used where Ajv cannot run because the runtime forbids code generation (Cloudflare Workers).
test("the interpreted validator accepts and rejects the same tool input", () => {
  const validate = interpretedValidator({
    type: "object",
    properties: { issueId: { type: "string", minLength: 1 } },
    required: ["issueId"],
    additionalProperties: false,
  });
  expect(validate({ issueId: "ENG-142" })).toBe(true);
  for (const bad of [{}, { issueId: "" }, { issueId: 1 }, { issueId: "a", extra: true }])
    expect(validate(bad)).toBe(false);
  expect(validate.errors?.[0]?.message).toBeTruthy();
});
