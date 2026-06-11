import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectNotion,
  getNotionStatus,
  savePostIdeaToNotion,
  startNotionConnect,
} from "./notionApi";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("notionApi", () => {
  it("reads notion status with the auth token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        connected: true,
        workspaceName: "Workspace",
        status: "connected",
        targetParentPageIdConfigured: true,
        targetDatabaseIdConfigured: false,
      }),
    );

    await expect(getNotionStatus("token")).resolves.toEqual({
      connected: true,
      workspaceName: "Workspace",
      status: "connected",
      targetParentPageIdConfigured: true,
      targetDatabaseIdConfigured: false,
    });
  });

  it("starts notion connect and returns the authorization url", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ authorizationUrl: "https://example.com/notion" }),
    );

    await expect(
      startNotionConnect({ redirectAfter: "/chat" }, "token"),
    ).resolves.toBe("https://example.com/notion");
  });

  it("calls disconnect without a token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(disconnectNotion()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notion/disconnect",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("saves a post idea into notion", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ pageUrl: "https://notion.so/page" }),
    );

    await expect(
      savePostIdeaToNotion(
        {
          title: "Idea",
          reason: "Why",
          suggestedPostText: "Post text",
        },
        "token",
      ),
    ).resolves.toEqual({ pageUrl: "https://notion.so/page" });
  });

  it("surfaces api errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "notion failed" }, { status: 500 }),
    );

    await expect(disconnectNotion("token")).rejects.toThrow("notion failed");
  });
});
