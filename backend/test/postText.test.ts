import { describe, expect, it } from "vitest";
import {
  countPostTextCharacters,
  isWithinPostTextLimit,
  truncatePostText,
} from "../src/utils/postText";

describe("postText", () => {
  it("counts emojis and line breaks as visible characters", () => {
    expect(countPostTextCharacters("A🙂\nB")).toBe(4);
  });

  it("keeps text within the shared limit", () => {
    expect(isWithinPostTextLimit("a".repeat(300))).toBe(true);
    expect(isWithinPostTextLimit("a".repeat(301))).toBe(false);
  });

  it("truncates overlong text with an ASCII ellipsis", () => {
    const text = truncatePostText("a".repeat(301));
    expect(countPostTextCharacters(text)).toBeLessThanOrEqual(300);
    expect(text.endsWith("...")).toBe(true);
  });
});
