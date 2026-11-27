import { MemoryResultCompiler } from "@runto/core";
import { expect, test } from "vitest";

test("a huge array does not push the small facts out of a compacted preview", () => {
  const compiled = new MemoryResultCompiler().compile(
    {
      comments: ["only carts with regional tax fail"],
      rawRecords: Array.from({ length: 80 }, (_, i) => ({ id: i, message: "x".repeat(100) })),
    },
    { maxInlineBytes: 1_000, maxPreviewBytes: 768 },
  );
  expect(compiled.inline).toBe(false);
  expect(compiled.content).toContain("only carts with regional tax fail");
  expect(compiled.content.length).toBeLessThan(1_500);
});
