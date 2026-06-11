import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatJobRepository } from "../src/repositories/chatJobRepository";
import type { ChatJobRecord } from "../src/types/chatJob";

const sendMock = vi.fn();

function marshallRecord(value: Record<string, unknown>) {
  return marshall(value, { removeUndefinedValues: true });
}

vi.mock("../src/aws/dynamodb", () => ({
  getDynamoDbClient: () => ({
    send: sendMock,
  }),
}));

describe("ChatJobRepository", () => {
  const originalTableName = process.env.CHAT_JOBS_TABLE_NAME;

  const baseRecord: ChatJobRecord = {
    jobId: "job-1",
    ownerKey: "anon:owner-token-1",
    ownerType: "anonymous",
    status: "queued",
    stage: "queued",
    progressMessages: [
      {
        at: "2026-06-08T00:00:00.000Z",
        stage: "queued",
        message: "蛻・梵繧帝幕蟋九＠縺ｾ縺励◆",
      },
    ],
    request: {
      question:
        "エンゲージメントが高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。",
      dashboardContext: {
        dashboardName: "Overview",
        workbookName: "Analytics",
        worksheets: [],
        filters: [],
        parameters: [],
        capturedAt: "2026-06-08T00:00:00.000Z",
      },
    } as never,
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    expiresAt: 1_999_999_999,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:00:00.000Z"));
    process.env.CHAT_JOBS_TABLE_NAME = "chat-jobs";
    sendMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTableName === undefined) {
      delete process.env.CHAT_JOBS_TABLE_NAME;
    } else {
      process.env.CHAT_JOBS_TABLE_NAME = originalTableName;
    }
  });

  it("creates a job record with owner, status, and ttl metadata", async () => {
    sendMock.mockResolvedValue({});
    const repository = new ChatJobRepository();

    await repository.create(baseRecord);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as PutItemCommand;
    expect(command.input.TableName).toBe("chat-jobs");
    expect(unmarshall(command.input.Item ?? {})).toMatchObject({
      jobId: "job-1",
      ownerKey: "anon:owner-token-1",
      ownerType: "anonymous",
      status: "queued",
      stage: "queued",
      expiresAt: 1_999_999_999,
    });
  });

  it("fetches a job by id", async () => {
    sendMock.mockResolvedValue({
      Item: marshall(baseRecord as Record<string, unknown>, {
        removeUndefinedValues: true,
      }),
    });
    const repository = new ChatJobRepository();

    await expect(repository.get("job-1")).resolves.toEqual(baseRecord);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as GetItemCommand;
    expect(command.input.TableName).toBe("chat-jobs");
  });

  it("appends progress messages when updating progress", async () => {
    const repository = new ChatJobRepository();
    sendMock
      .mockResolvedValueOnce({
        Item: marshallRecord({
          ...baseRecord,
          progressMessages: baseRecord.progressMessages,
        }),
      })
      .mockResolvedValueOnce({
        Attributes: marshallRecord({
          ...baseRecord,
          status: "running",
          stage: "planning",
          updatedAt: "2026-06-08T00:00:05.000Z",
          progressMessages: [
            ...baseRecord.progressMessages,
            {
              at: "2026-06-08T00:00:05.000Z",
              stage: "planning",
              message: "分析計画を作成中...",
              debug: {
                provider: "tableau-mcp",
              },
            },
          ],
        }),
      });

    const updated = await repository.updateProgress("job-1", {
      stage: "planning",
      message: "分析計画を作成中...",
      debug: {
        provider: "tableau-mcp",
      },
      status: "running",
      maxMessages: 12,
    });

    expect(updated?.progressMessages).toHaveLength(2);
    expect(updated?.status).toBe("running");
    expect(updated?.stage).toBe("planning");
    expect(sendMock).toHaveBeenCalledTimes(2);
    const updateCommand = sendMock.mock.calls[1][0] as UpdateItemCommand;
    expect(updateCommand.input.TableName).toBe("chat-jobs");
    expect(updateCommand.input.ExpressionAttributeValues?.[":status"]).toEqual({
      S: "running",
    });
    expect(updateCommand.input.ExpressionAttributeValues?.[":stage"]).toEqual({
      S: "planning",
    });
  });

  it("marks jobs completed and preserves the answer payload", async () => {
    const repository = new ChatJobRepository();
    sendMock.mockResolvedValue({
      Attributes: marshallRecord({
        ...baseRecord,
        status: "completed",
        stage: "completed",
        result: {
          answer: "## 結論\n\n処理が完了しました。",
          sessionId: "session-1",
          messageId: "message-1",
        },
        completedAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
        expiresAt: 1_999_999_999,
      }),
    });

    const updated = await repository.markCompleted({
      jobId: "job-1",
      result: {
        answer: "## 結論\n\n完了しました。",
        sessionId: "session-1",
        messageId: "message-1",
      },
    });

    expect(updated?.status).toBe("completed");
    expect(updated?.result?.answer).toContain("## 結論");
    expect(updated?.completedAt).toBe("2026-06-08T00:00:00.000Z");
  });

  it("marks jobs failed and preserves the error payload", async () => {
    const repository = new ChatJobRepository();
    sendMock.mockResolvedValue({
      Attributes: marshall(
        {
          ...baseRecord,
          status: "failed",
          stage: "failed",
          error: {
            code: "worker_failed",
            message:
              "## 回答できなかった理由\n\n- 実データの取得に失敗しました。",
          },
          completedAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
          expiresAt: 1_999_999_999,
        } as Record<string, unknown>,
        { removeUndefinedValues: true },
      ),
    });

    const updated = await repository.markFailed({
      jobId: "job-1",
      error: {
        code: "worker_failed",
        message: "## 回答できなかった理由\n\n- 実データの取得に失敗しました。",
      },
    });

    expect(updated?.status).toBe("failed");
    expect(updated?.error?.message).toContain("## 回答できなかった理由");
    expect(updated?.completedAt).toBe("2026-06-08T00:00:00.000Z");
  });

  it("returns a public view with the job status and owner type", async () => {
    const repository = new ChatJobRepository();

    await expect(repository.toPublicView(baseRecord)).resolves.toEqual({
      jobId: "job-1",
      status: "queued",
      stage: "queued",
      progressMessages: baseRecord.progressMessages,
      createdAt: baseRecord.createdAt,
      updatedAt: baseRecord.updatedAt,
      expiresAt: baseRecord.expiresAt,
      ownerType: "anonymous",
    });
  });
});
