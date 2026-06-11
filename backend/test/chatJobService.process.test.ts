import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMock = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  claim: vi.fn(),
  updateProgress: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  toPublicView: vi.fn(),
}));

const chatServiceMock = vi.hoisted(() => ({
  generateAnswer: vi.fn(),
  getDashboardContextPatch: vi.fn(),
}));

vi.mock("../src/repositories/chatJobRepository", () => ({
  ChatJobRepository: vi.fn().mockImplementation(() => repositoryMock),
}));

vi.mock("../src/services/chatService", () => ({
  createChatService: () => chatServiceMock,
}));

import { ChatJobService } from "../src/services/chatJobService";

describe("ChatJobService processChatJob", () => {
  const originalLeaseSeconds = process.env.CHAT_JOB_LEASE_SECONDS;
  const originalProgressLimit = process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT;

  beforeEach(() => {
    process.env.CHAT_JOB_LEASE_SECONDS = "120";
    process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT = "12";

    repositoryMock.claim.mockReset();
    repositoryMock.updateProgress.mockReset();
    repositoryMock.markCompleted.mockReset();
    repositoryMock.markFailed.mockReset();
    chatServiceMock.generateAnswer.mockReset();
  });

  afterEach(() => {
    if (originalLeaseSeconds === undefined) {
      delete process.env.CHAT_JOB_LEASE_SECONDS;
    } else {
      process.env.CHAT_JOB_LEASE_SECONDS = originalLeaseSeconds;
    }

    if (originalProgressLimit === undefined) {
      delete process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT;
    } else {
      process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT = originalProgressLimit;
    }
  });

  it("saves progress and completes the job", async () => {
    const service = new ChatJobService();
    repositoryMock.claim.mockResolvedValue({
      jobId: "job-1",
      ownerKey: "user:user-1",
      ownerType: "authenticated",
      ownerUserId: "user-1",
      status: "queued",
      stage: "queued",
      progressMessages: [],
      request: {
        question: "What changed?",
        dashboardContext: {
          dashboardName: "Dashboard",
          worksheets: [],
          filters: [],
          parameters: [],
          capturedAt: "2026-06-07T00:00:00.000Z",
        },
        clientContext: {
          source: "tableau-extension",
          appVersion: "1.0.0",
        },
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      expiresAt: 1_999_999_999,
    });

    chatServiceMock.generateAnswer.mockImplementation(
      async (_request, _user, options) => {
        await options.progressReporter.report({
          stage: "planning",
          message: "Planning the analysis.",
          toolName: "get-workbook",
          debug: { toolCallCount: 1 },
        });

        return {
          answer: "Completed answer",
          sessionId: "session-1",
          messageId: "message-1",
        };
      },
    );
    repositoryMock.markCompleted.mockResolvedValue(null);

    await service.processChatJob(
      {
        jobId: "job-1",
        getRemainingTimeInMillis: () => 20_000,
      },
      { userId: "user-1", email: "user@example.com", tableauSubject: "sub-1" },
    );

    expect(repositoryMock.claim).toHaveBeenCalledTimes(1);
    expect(chatServiceMock.generateAnswer).toHaveBeenCalledTimes(1);
    expect(chatServiceMock.generateAnswer.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        conversationOwnerKey: "user-1",
        getRemainingTimeInMillis: expect.any(Function),
      }),
    );
    expect(repositoryMock.updateProgress).toHaveBeenCalled();
    expect(repositoryMock.markCompleted).toHaveBeenCalledWith({
      jobId: "job-1",
      result: expect.objectContaining({
        answer: "Completed answer",
        sessionId: "session-1",
        messageId: "message-1",
      }),
    });

    const progressCalls = repositoryMock.updateProgress.mock.calls;
    const lastProgressUpdate = progressCalls[progressCalls.length - 1]?.[1];
    expect(lastProgressUpdate).toEqual(
      expect.objectContaining({
        stage: "completed",
        status: "completed",
      }),
    );
  });

  it("marks the job as failed when answer generation throws", async () => {
    const service = new ChatJobService();
    repositoryMock.claim.mockResolvedValue({
      jobId: "job-2",
      ownerKey: "anon:owner-token",
      ownerType: "anonymous",
      status: "queued",
      stage: "queued",
      progressMessages: [],
      request: {
        question: "What changed?",
        dashboardContext: {
          dashboardName: "Dashboard",
          worksheets: [],
          filters: [],
          parameters: [],
          capturedAt: "2026-06-07T00:00:00.000Z",
        },
        clientContext: {
          source: "tableau-extension",
          appVersion: "1.0.0",
        },
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      expiresAt: 1_999_999_999,
    });

    chatServiceMock.generateAnswer.mockRejectedValue(
      new Error("bedrock unavailable"),
    );
    repositoryMock.markFailed.mockResolvedValue(null);

    await service.processChatJob({ jobId: "job-2" }, undefined);

    expect(repositoryMock.markFailed).toHaveBeenCalledWith({
      jobId: "job-2",
      error: expect.objectContaining({
        code: "Error",
        message: "bedrock unavailable",
      }),
    });

    const progressCalls = repositoryMock.updateProgress.mock.calls;
    const lastProgressUpdate = progressCalls[progressCalls.length - 1]?.[1];
    expect(lastProgressUpdate).toEqual(
      expect.objectContaining({
        stage: "failed",
        status: "failed",
      }),
    );
  });
});
