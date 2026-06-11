import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOwnerContext } from "../src/services/chatJobService";

describe("resolveOwnerContext", () => {
  const originalHeaderName = process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME;

  beforeEach(() => {
    process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = "x-chat-owner-token";
  });

  afterEach(() => {
    if (originalHeaderName === undefined) {
      delete process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME;
    } else {
      process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = originalHeaderName;
    }
  });

  it("uses the configured anonymous owner token header", () => {
    const result = resolveOwnerContext({
      headers: {
        "X-Chat-Owner-Token": "owner-token-123",
      },
    });

    expect(result.ownerKey).toBe("anon:owner-token-123");
    expect(result.ownerToken).toBe("owner-token-123");
  });

  it("generates an anonymous owner token when the header is missing", () => {
    const result = resolveOwnerContext({});

    expect(result.ownerKey.startsWith("anon:")).toBe(true);
    expect(result.ownerToken).toBeTruthy();
  });
});
