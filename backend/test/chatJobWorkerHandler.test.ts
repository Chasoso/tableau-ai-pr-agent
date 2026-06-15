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

const tableauDiagnosticsMocks = vi.hoisted(() => ({
  runTableauConnectivityDiagnostics: vi.fn(),
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

vi.mock("../src/services/tableauConnectivityDiagnostics", () => ({
  runTableauConnectivityDiagnostics:
    tableauDiagnosticsMocks.runTableauConnectivityDiagnostics,
}));

import { handler } from "../src/handlers/chatJobWorkerHandler";

describe("chatJobWorkerHandler", () => {
  beforeEach(() => {
    chatJobMocks.processChatJob.mockReset();
    actionRunMocks.processActionRun.mockReset();
    repositoryMocks.get.mockReset();
    tableauDiagnosticsMocks.runTableauConnectivityDiagnostics.mockReset();
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

  it("logs Tableau diagnostics when the worker fails", async () => {
    repositoryMocks.get.mockResolvedValue({ jobType: "chat" });
    chatJobMocks.processChatJob.mockRejectedValue(
      new Error("Fatal error initializing server info"),
    );
    tableauDiagnosticsMocks.runTableauConnectivityDiagnostics.mockResolvedValue(
      {
        enabled: true,
        reachability: {
          ok: false,
          error: {
            errorName: "TypeError",
            errorMessage: "fetch failed",
          },
        },
        authentication: {
          ok: false,
          error: {
            errorName: "ConfigurationError",
            errorMessage: "TABLEAU_DEFAULT_SUBJECT is not configured.",
          },
        },
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // noop
    });

    await expect(
      handler(
        { jobId: "job-123" },
        {
          getRemainingTimeInMillis: () => 12_345,
        },
      ),
    ).rejects.toThrow("Fatal error initializing server info");

    const failureLog = errorSpy.mock.calls
      .map(
        ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>,
      )
      .find((payload) => payload.event === "chat.job.worker.failed");

    expect(failureLog).toEqual(
      expect.objectContaining({
        tableauDiagnostics: expect.objectContaining({
          enabled: true,
          reachability: expect.objectContaining({ ok: false }),
        }),
      }),
    );
    expect(
      tableauDiagnosticsMocks.runTableauConnectivityDiagnostics,
    ).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
