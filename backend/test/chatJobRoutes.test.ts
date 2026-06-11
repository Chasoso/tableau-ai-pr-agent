import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatJobMocks = vi.hoisted(() => ({
  createChatJob: vi.fn(),
  getChatJob: vi.fn(),
}));

vi.mock("../src/services/chatJobService", () => ({
  ChatJobService: vi.fn().mockImplementation(() => chatJobMocks),
}));

import { handler } from "../src/handlers/chatHandler";

describe("chat job routes", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;

  beforeEach(() => {
    delete process.env.AUTH_REQUIRED;
    chatJobMocks.createChatJob.mockReset();
    chatJobMocks.getChatJob.mockReset();
  });

  afterEach(() => {
    if (originalAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = originalAuthRequired;
    }
  });

  it("creates a chat job and returns 202 with the job id", async () => {
    chatJobMocks.createChatJob.mockResolvedValue({
      jobId: "job-123",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-123",
      retryAfterMs: 1500,
      ownerToken: "owner-token",
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/chat-jobs",
      headers: {},
      body: JSON.stringify({
        question: "What changed?",
        dashboardContext: {
          dashboardName: "Dashboard",
          worksheets: [],
          filters: [],
          parameters: [],
          capturedAt: new Date().toISOString(),
        },
      }),
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      jobId: "job-123",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-123",
      retryAfterMs: 1500,
      ownerToken: "owner-token",
    });
    expect(chatJobMocks.createChatJob).toHaveBeenCalledTimes(1);
  });

  it("fetches a chat job by id", async () => {
    chatJobMocks.getChatJob.mockResolvedValue({
      jobId: "job-123",
      status: "running",
      stage: "planning",
      progressMessages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ownerType: "anonymous",
    });

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/chat-jobs/job-123",
      headers: {},
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      jobId: "job-123",
      status: "running",
      stage: "planning",
      ownerType: "anonymous",
    });
    expect(chatJobMocks.getChatJob).toHaveBeenCalledTimes(1);
    expect(chatJobMocks.getChatJob).toHaveBeenCalledWith({
      jobId: "job-123",
      authenticatedUser: undefined,
      headers: {},
    });
  });

  it("returns 403 when the current user does not own the job", async () => {
    chatJobMocks.getChatJob.mockRejectedValue(
      new Error("You do not have access to this chat job."),
    );

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/chat-jobs/job-456",
      headers: {},
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      message: "You do not have access to this chat job.",
    });
  });

  it("returns 404 when the job is missing", async () => {
    chatJobMocks.getChatJob.mockRejectedValue(new Error("Chat job not found."));

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/chat-jobs/job-missing",
      headers: {},
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      message: "Chat job not found.",
    });
  });
});
