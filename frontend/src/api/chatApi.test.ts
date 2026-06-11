import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatJob, getChatJob, sendChatQuestion } from "./chatApi";

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

describe("chatApi", () => {
  it("sends the bearer token when provided", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answer: "hello",
        shouldPersist: false,
        prompt: "question",
        modelUsed: "mock",
        contextSummary: null,
        chatHistory: [],
      }),
    );

    await expect(
      sendChatQuestion({ question: "hello" } as never, "token-1"),
    ).resolves.toEqual({
      answer: "hello",
      shouldPersist: false,
      prompt: "question",
      modelUsed: "mock",
      contextSummary: null,
      chatHistory: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
        }),
      }),
    );
  });

  it("omits the bearer token when not provided", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answer: "hello",
        shouldPersist: false,
        prompt: "question",
        modelUsed: "mock",
        contextSummary: null,
        chatHistory: [],
      }),
    );

    await sendChatQuestion({ question: "hello" } as never);

    const [, options] = fetchMock.mock.calls[0];
    expect((options as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("rejects non-json responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      sendChatQuestion({ question: "hello" } as never),
    ).rejects.toThrow("non-JSON response");
  });

  it("surfaces api error messages", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "backend failed" }, { status: 500 }),
    );

    await expect(
      sendChatQuestion({ question: "hello" } as never),
    ).rejects.toThrow("backend failed");
  });

  it("creates chat jobs with the owner token header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobId: "job-1",
        status: "queued",
        stage: "queued",
        pollUrl: "/chat-jobs/job-1",
        retryAfterMs: 1500,
        ownerToken: "owner-token-1",
      }),
    );

    await expect(
      createChatJob({ question: "hello" } as never, "token-1", "owner-1"),
    ).resolves.toEqual({
      jobId: "job-1",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-1",
      retryAfterMs: 1500,
      ownerToken: "owner-token-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat-jobs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "X-Chat-Owner-Token": "owner-1",
        }),
      }),
    );
  });

  it("polls chat jobs with the owner token header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobId: "job-1",
        status: "running",
        stage: "planning",
        progressMessages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        ownerType: "anonymous",
      }),
    );

    await expect(getChatJob("job-1", undefined, "owner-1")).resolves.toEqual(
      expect.objectContaining({
        jobId: "job-1",
        status: "running",
        stage: "planning",
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat-jobs/job-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Chat-Owner-Token": "owner-1",
        }),
      }),
    );
  });
});
