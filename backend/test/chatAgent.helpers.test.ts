import { describe, expect, it } from "vitest";
import { mergeAdditionalContexts } from "../src/services/chatAgent";

describe("chatAgent helpers", () => {
  it("prefers the latest additional context while preserving earlier metadata", () => {
    const merged = mergeAdditionalContexts([
      {
        provider: "mock",
        workbook: { type: "workbook", name: "Old Workbook" },
        warnings: ["old warning"],
      },
      {
        provider: "tableau-mcp",
        metadata: { hasMetadata: true },
        warnings: ["new warning"],
      },
    ]);

    expect(merged.provider).toBe("tableau-mcp");
    expect(merged.workbook).toEqual({
      type: "workbook",
      name: "Old Workbook",
    });
    expect(merged.metadata).toEqual({ hasMetadata: true });
    expect(merged.warnings).toEqual(["old warning", "new warning"]);
  });
});
