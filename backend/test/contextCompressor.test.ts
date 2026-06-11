import { describe, expect, it } from "vitest";
import { safeJsonSnippet } from "../src/services/contextCompressor";

describe("contextCompressor", () => {
  it("redacts token and authorization style keys from json snippets", () => {
    const snippet = safeJsonSnippet(
      {
        token: "secret-token",
        cookie: "session-cookie",
        authorization: "Bearer abc",
        secretValue: "top-secret",
        nested: {
          password: "hidden",
          visible: "keep-me",
        },
      },
      500,
    );

    expect(snippet).toContain("[REDACTED]");
    expect(snippet).toContain("keep-me");
    expect(snippet).not.toContain("secret-token");
    expect(snippet).not.toContain("session-cookie");
    expect(snippet).not.toContain("Bearer abc");
    expect(snippet).not.toContain("top-secret");
    expect(snippet).not.toContain("hidden");
  });
});
