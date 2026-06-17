import { describe, expect, it } from "vitest";
import {
  countPostTextCharacters,
  isWithinPostTextLimit,
  truncatePostText,
} from "./postText";

describe("frontend postText", () => {
  it("counts emoji and line breaks consistently", () => {
    expect(countPostTextCharacters("A🙂\nB")).toBe(4);
  });

  it("detects when text is within the shared limit", () => {
    expect(isWithinPostTextLimit("a".repeat(300))).toBe(true);
    expect(isWithinPostTextLimit("a".repeat(301))).toBe(false);
  });

  it("truncates overlong text with an ASCII ellipsis", () => {
    const text = truncatePostText("a".repeat(301));
    expect(countPostTextCharacters(text)).toBeLessThanOrEqual(300);
    expect(text.endsWith("...")).toBe(true);
  });
});
