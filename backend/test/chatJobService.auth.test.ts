import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest } from "../src/types/chat";

const repositoryMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  updateProgress: vi.fn().mockResolvedValue(null),
  markCompleted: vi.fn().mockResolvedValue(null),
  markFailed: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/repositories/chatJobRepository", () => ({
  ChatJobRepository: vi.fn().mockImplementation(() => repositoryMocks),
}));

const chatServiceMocks = vi.hoisted(() => ({
  generateAnswer: vi.fn(),
}));

vi.mock("../src/services/chatService", () => ({
  createChatService: vi.fn(() => ({
    generateAnswer: chatServiceMocks.generateAnswer,
  })),
}));

import { ChatJobService } from "../src/services/chatJobService";

describe("ChatJobService auth snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the authenticated user snapshot before invoking ChatService", async () => {
    const service = new ChatJobService();
    const request: ChatRequest = {
      question: "Show the top workbooks",
      dashboardContext: {
        dashboardName: "Dashboard",
        worksheets: [{ name: "Sheet 1" }],
        filters: [],
        parameters: [],
        capturedAt: "2026-06-07T00:00:00.000Z",
      },
      sessionId: "session-123",
    };

    repositoryMocks.claim.mockResolvedValue({
      jobId: "job-123",
      ownerKey: "user:user-123",
      ownerType: "authenticated",
      ownerUserId: "user-123",
      authContextSnapshot: {
        userId: "user-123",
        email: "user@example.com",
        tableauSubject: "user@example.com",
        tokenUse: "access",
      },
      status: "queued",
      stage: "queued",
      progressMessages: [],
      request,
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      expiresAt: 1_799_999_999,
    });

    chatServiceMocks.generateAnswer.mockResolvedValue({
      answer: "done",
      sessionId: "session-123",
      messageId: "message-123",
    });

    await service.processChatJob(
      { jobId: "job-123", getRemainingTimeInMillis: () => 10_000 },
      undefined,
    );

    expect(chatServiceMocks.generateAnswer).toHaveBeenCalledTimes(1);
    const [, authenticatedUser, options] =
      chatServiceMocks.generateAnswer.mock.calls[0] ?? [];
    expect(authenticatedUser).toEqual({
      userId: "user-123",
      email: "user@example.com",
      tableauSubject: "user@example.com",
      tokenUse: "access",
    });
    expect(options).toEqual(
      expect.objectContaining({
        conversationOwnerKey: "user-123",
      }),
    );
    expect(repositoryMocks.markCompleted).toHaveBeenCalledWith({
      jobId: "job-123",
      result: expect.objectContaining({
        answer: "done",
        sessionId: "session-123",
        messageId: "message-123",
      }),
    });
  });
});
