import { beforeEach, describe, expect, it, vi } from "vitest";

const chatJobMocks = vi.hoisted(() => ({
  processChatJob: vi.fn(),
}));

const actionRunMocks = vi.hoisted(() => ({
  processActionRun: vi.fn(),
}));

const repositoryMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../src/repositories/chatJobRepository", () => ({
  ChatJobRepository: vi.fn().mockImplementation(() => repositoryMocks),
}));

vi.mock("../src/services/chatJobService", () => ({
  ChatJobService: vi.fn().mockImplementation(() => chatJobMocks),
}));

vi.mock("../src/services/actionRunService", () => ({
  ActionRunService: vi.fn().mockImplementation(() => actionRunMocks),
}));

import { handler } from "../src/handlers/chatJobWorkerHandler";

describe("chatJobWorkerHandler", () => {
  beforeEach(() => {
    chatJobMocks.processChatJob.mockReset();
    actionRunMocks.processActionRun.mockReset();
    repositoryMocks.get.mockReset();
  });

  it("invokes the chat job processor for chat jobs", async () => {
    repositoryMocks.get.mockResolvedValue({ jobType: "chat" });
    chatJobMocks.processChatJob.mockResolvedValue(undefined);

    const response = await handler(
      { jobId: "job-123" },
      {
        getRemainingTimeInMillis: () => 12_345,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(chatJobMocks.processChatJob).toHaveBeenCalledTimes(1);
    expect(chatJobMocks.processChatJob).toHaveBeenCalledWith(
      {
        jobId: "job-123",
        getRemainingTimeInMillis: expect.any(Function),
      },
      undefined,
    );
    expect(actionRunMocks.processActionRun).not.toHaveBeenCalled();
  });

  it("invokes the action run processor for action run jobs", async () => {
    repositoryMocks.get.mockResolvedValue({ jobType: "action_run" });
    actionRunMocks.processActionRun.mockResolvedValue(undefined);

    const response = await handler(
      { jobId: "action-run-123" },
      {
        getRemainingTimeInMillis: () => 12_345,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(actionRunMocks.processActionRun).toHaveBeenCalledTimes(1);
    expect(actionRunMocks.processActionRun).toHaveBeenCalledWith(
      {
        actionRunId: "action-run-123",
        getRemainingTimeInMillis: expect.any(Function),
      },
      undefined,
    );
  });
});
