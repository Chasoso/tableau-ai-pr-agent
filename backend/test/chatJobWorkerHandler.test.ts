import { describe, expect, it, vi } from "vitest";

const chatJobMocks = vi.hoisted(() => ({
  processChatJob: vi.fn(),
}));

vi.mock("../src/services/chatJobService", () => ({
  ChatJobService: vi.fn().mockImplementation(() => chatJobMocks),
}));

import { handler } from "../src/handlers/chatJobWorkerHandler";

describe("chatJobWorkerHandler", () => {
  it("invokes the job processor for the provided job id", async () => {
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
  });
});
