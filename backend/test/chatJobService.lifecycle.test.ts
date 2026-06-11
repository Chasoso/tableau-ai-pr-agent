import { InvokeCommand } from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatJobService } from "../src/services/chatJobService";
import type { ChatJobRecord } from "../src/types/chatJob";

const repositoryMock = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  claim: vi.fn(),
  updateProgress: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  toPublicView: vi.fn(),
}));

const lambdaSendMock = vi.hoisted(() => vi.fn());

vi.mock("../src/repositories/chatJobRepository", () => ({
  ChatJobRepository: vi.fn().mockImplementation(() => repositoryMock),
}));

vi.mock("../src/aws/lambda", () => ({
  getLambdaClient: () => ({
    send: lambdaSendMock,
  }),
}));

vi.mock("../src/services/chatService", () => ({
  createChatService: vi.fn(),
}));

describe("ChatJobService lifecycle", () => {
  const originalWorkerFunctionName = process.env.CHAT_JOB_WORKER_FUNCTION_NAME;
  const originalOwnerHeader = process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:00:00.000Z"));
    process.env.CHAT_JOB_WORKER_FUNCTION_NAME = "chat-job-worker";
    process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = "x-chat-owner-token";

    repositoryMock.create.mockReset();
    repositoryMock.get.mockReset();
    repositoryMock.claim.mockReset();
    repositoryMock.updateProgress.mockReset();
    repositoryMock.markCompleted.mockReset();
    repositoryMock.markFailed.mockReset();
    repositoryMock.toPublicView.mockReset();
    lambdaSendMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalWorkerFunctionName === undefined) {
      delete process.env.CHAT_JOB_WORKER_FUNCTION_NAME;
    } else {
      process.env.CHAT_JOB_WORKER_FUNCTION_NAME = originalWorkerFunctionName;
    }

    if (originalOwnerHeader === undefined) {
      delete process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME;
    } else {
      process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = originalOwnerHeader;
    }
  });

  it("returns a job id immediately and dispatches the worker lambda", async () => {
    repositoryMock.create.mockResolvedValue(undefined);
    lambdaSendMock.mockResolvedValue({});
    const service = new ChatJobService();

    const response = await service.createChatJob({
      request: buildRequest(),
      headers: {
        "X-Chat-Owner-Token": "owner-token-123",
      },
    });

    expect(response.jobId).toBeTruthy();
    expect(response.status).toBe("queued");
    expect(response.stage).toBe("queued");
    expect(response.ownerToken).toBe("owner-token-123");
    expect(repositoryMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: "anon:owner-token-123",
        status: "queued",
        stage: "queued",
        expiresAt: expect.any(Number),
      }),
    );

    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const command = lambdaSendMock.mock.calls[0][0] as InvokeCommand;
    expect(command.input.FunctionName).toBe("chat-job-worker");
    expect(command.input.InvocationType).toBe("Event");
  });

  it("marks the job as failed when worker startup fails", async () => {
    repositoryMock.create.mockResolvedValue(undefined);
    repositoryMock.markFailed.mockResolvedValue(null);
    lambdaSendMock.mockRejectedValue(new Error("worker unavailable"));
    const service = new ChatJobService();

    await expect(
      service.createChatJob({
        request: buildRequest(),
      }),
    ).rejects.toThrow("Failed to start chat job.");

    expect(repositoryMock.markFailed).toHaveBeenCalledWith({
      jobId: expect.any(String),
      error: expect.objectContaining({
        code: "dispatch_failed",
        message: "Worker Lambda invocation failed.",
      }),
    });
  });

  it.each([
    ["queued", "queued"],
    ["running", "planning"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)(
    "returns %s polling state through getChatJob",
    async (status, stage) => {
      const service = new ChatJobService();
      const record = buildJobRecord(status, stage);
      repositoryMock.get.mockResolvedValue(record);
      repositoryMock.toPublicView.mockResolvedValue({
        jobId: record.jobId,
        status: record.status,
        stage: record.stage,
        progressMessages: record.progressMessages,
        ...(record.result ? { result: record.result } : {}),
        ...(record.error ? { error: record.error } : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
        ownerType: record.ownerType,
      });

      const response = await service.getChatJob({
        jobId: record.jobId,
        headers: {
          "X-Chat-Owner-Token": "owner-token-123",
        },
      });

      expect(response.status).toBe(status);
      expect(response.stage).toBe(stage);
      expect(repositoryMock.get).toHaveBeenCalledWith(record.jobId);
      expect(repositoryMock.toPublicView).toHaveBeenCalledWith(record);
    },
  );

  it("rejects polling access when the owner token does not match", async () => {
    const service = new ChatJobService();
    repositoryMock.get.mockResolvedValue(buildJobRecord("running", "planning"));

    await expect(
      service.getChatJob({
        jobId: "job-1",
        headers: {
          "X-Chat-Owner-Token": "different-owner",
        },
      }),
    ).rejects.toThrow("You do not have access to this chat job.");
  });
});

function buildRequest() {
  return {
    question:
      "エンゲージメントが高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-08T00:00:00.000Z",
      dataSources: [{ name: "X Account Analytics Contents" }],
    },
  } as never;
}

function buildJobRecord(
  status: ChatJobRecord["status"],
  stage: ChatJobRecord["stage"],
): ChatJobRecord {
  return {
    jobId: "job-1",
    ownerKey: "anon:owner-token-123",
    ownerType: "anonymous",
    status,
    stage,
    progressMessages: [
      {
        at: "2026-06-08T00:00:00.000Z",
        stage: "queued",
        message: "蛻・梵繧帝幕蟋九＠縺ｾ縺励◆",
      },
    ],
    request: buildRequest(),
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    expiresAt: 1_999_999_999,
    ...(status === "completed"
      ? {
          result: {
            answer: "## 結論\n\n完了しました。",
            sessionId: "session-1",
            messageId: "message-1",
          },
        }
      : {}),
    ...(status === "failed"
      ? {
          error: {
            code: "worker_failed",
            message:
              "## 回答できなかった理由\n\n- 実データの取得に失敗しました。",
          },
        }
      : {}),
  };
}
