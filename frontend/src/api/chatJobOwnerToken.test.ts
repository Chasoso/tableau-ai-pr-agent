import { afterEach, describe, expect, it } from "vitest";
import {
  clearChatJobOwnerToken,
  loadChatJobOwnerToken,
  storeChatJobOwnerToken,
} from "./chatJobOwnerToken";

describe("chatJobOwnerToken", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("stores, loads, and clears the anonymous owner token", () => {
    expect(loadChatJobOwnerToken()).toBeNull();

    storeChatJobOwnerToken("owner-token-1");
    expect(loadChatJobOwnerToken()).toBe("owner-token-1");

    clearChatJobOwnerToken();
    expect(loadChatJobOwnerToken()).toBeNull();
  });
});
