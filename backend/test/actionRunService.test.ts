import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRunService } from "../src/services/actionRunService";
import type { ActionRunRecord } from "../src/types/actionRun";

const repositoryMock = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  toPublicView: vi.fn(),
  claim: vi.fn(),
  updateProgress: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

const analysisMock = vi.hoisted(() => ({
  analyzeActionRun: vi.fn(),
}));

const slackMock = vi.hoisted(() => ({
  postActionRun: vi.fn(),
}));

vi.mock("../src/repositories/actionRunRepository", () => ({
  ActionRunRepository: vi.fn().mockImplementation(() => repositoryMock),
}));

vi.mock("../src/services/actionRunAnalysisService", () => ({
  ActionRunAnalysisService: vi.fn().mockImplementation(() => analysisMock),
}));

vi.mock("../src/services/slackWebhookService", () => ({
  SlackWebhookService: vi.fn().mockImplementation(() => slackMock),
}));

describe("ActionRunService", () => {
  const originalTableName = process.env.CHAT_JOBS_TABLE_NAME;
  const originalOwnerHeader = process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME;
  const originalImageBaseUrl = process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL;
  const originalImagePrefix = process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:00:00.000Z"));
    process.env.CHAT_JOBS_TABLE_NAME = "chat-jobs";
    process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = "x-chat-owner-token";
    process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL = "https://images.example.com";
    process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX = "pr-action-images";

    repositoryMock.create.mockReset();
    repositoryMock.get.mockReset();
    repositoryMock.toPublicView.mockReset();
    repositoryMock.claim.mockReset();
    repositoryMock.updateProgress.mockReset();
    repositoryMock.markCompleted.mockReset();
    repositoryMock.markFailed.mockReset();
    analysisMock.analyzeActionRun.mockReset();
    slackMock.postActionRun.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTableName === undefined) {
      delete process.env.CHAT_JOBS_TABLE_NAME;
    } else {
      process.env.CHAT_JOBS_TABLE_NAME = originalTableName;
    }

    if (originalOwnerHeader === undefined) {
      delete process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME;
    } else {
      process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = originalOwnerHeader;
    }

    if (originalImageBaseUrl === undefined) {
      delete process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL;
    } else {
      process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL = originalImageBaseUrl;
    }

    if (originalImagePrefix === undefined) {
      delete process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX;
    } else {
      process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX = originalImagePrefix;
    }
  });

  it("returns a queued action run immediately", async () => {
    repositoryMock.create.mockResolvedValue(undefined);
    const service = new ActionRunService();

    const response = await service.createActionRun({
      request: buildRequest(),
      headers: {
        "X-Chat-Owner-Token": "owner-token-123",
      },
    });

    expect(response.actionRunId).toBeTruthy();
    expect(response.jobType).toBe("action_run");
    expect(response.status).toBe("queued");
    expect(response.stage).toBe("queued");
    expect(response.ownerToken).toBe("owner-token-123");
    expect(repositoryMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "action_run",
        ownerKey: "anon:owner-token-123",
        status: "queued",
        stage: "queued",
        expiresAt: expect.any(Number),
      }),
    );
  });

  it("processes an action run with fixed Tableau analysis", async () => {
    repositoryMock.claim.mockResolvedValue(buildActionRunRecord());
    repositoryMock.updateProgress.mockResolvedValue(buildActionRunRecord());
    repositoryMock.markCompleted.mockResolvedValue(buildActionRunRecord());
    slackMock.postActionRun.mockResolvedValue({
      sent: true,
      skipped: false,
      statusCode: 200,
    });
    analysisMock.analyzeActionRun.mockResolvedValue({
      summary: "analysis summary",
      suggestedSlackPostText: "draft text",
      hashtags: ["#Tableau"],
      evidence: ["evidence line"],
      checks: ["check line"],
      analysisSections: [],
      debug: { source: "stub" },
    });

    const service = new ActionRunService();
    await service.processActionRun({
      actionRunId: "action-run-1",
    });

    expect(repositoryMock.claim).toHaveBeenCalledWith(
      "action-run-1",
      expect.objectContaining({
        workerId: expect.stringMatching(/^worker-/),
      }),
    );
    expect(analysisMock.analyzeActionRun).toHaveBeenCalledTimes(1);
    expect(slackMock.postActionRun).toHaveBeenCalledTimes(1);
    expect(repositoryMock.markCompleted).toHaveBeenCalledWith({
      actionRunId: "action-run-1",
      result: expect.objectContaining({
        summary: "analysis summary",
        imageUrl:
          "https://images.example.com/pr-action-images/action-run-1/poster.png",
      }),
    });
    expect(slackMock.postActionRun).toHaveBeenCalledWith({
      request: expect.any(Object),
      result: expect.objectContaining({
        imageUrl:
          "https://images.example.com/pr-action-images/action-run-1/poster.png",
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

  it("returns a public view when polling action runs", async () => {
    const service = new ActionRunService();
    const record = buildActionRunRecord();
    repositoryMock.get.mockResolvedValue(record);
    repositoryMock.toPublicView.mockResolvedValue({
      actionRunId: record.jobId,
      jobType: "action_run",
      status: record.status,
      stage: record.stage,
      progressMessages: record.progressMessages,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      ownerType: record.ownerType,
    });

    const response = await service.getActionRun({
      actionRunId: record.jobId,
      headers: {
        "X-Chat-Owner-Token": "owner-token-123",
      },
    });

    expect(response.actionRunId).toBe(record.jobId);
    expect(response.status).toBe(record.status);
    expect(repositoryMock.get).toHaveBeenCalledWith(record.jobId);
    expect(repositoryMock.toPublicView).toHaveBeenCalledWith(record);
  });

  it("rejects polling access when the owner token does not match", async () => {
    const service = new ActionRunService();
    repositoryMock.get.mockResolvedValue(buildActionRunRecord());

    await expect(
      service.getActionRun({
        actionRunId: "action-run-1",
        headers: {
          "X-Chat-Owner-Token": "different-owner",
        },
      }),
    ).rejects.toThrow("You do not have access to this action run.");
  });
});

function buildRequest() {
  return {
    postType: "\u4e8b\u524d\u544a\u77e5",
    eventName: "Tableau User Group Tokyo 2026",
    techplayUrl: "https://techplay.jp/event/123",
    currentSituation: "The venue is filling up.",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  } as never;
}

function buildActionRunRecord(): ActionRunRecord {
  return {
    jobId: "action-run-1",
    jobType: "action_run",
    ownerKey: "anon:owner-token-123",
    ownerType: "anonymous",
    status: "queued",
    stage: "queued",
    progressMessages: [
      {
        at: "2026-06-08T00:00:00.000Z",
        stage: "queued",
        message: "Action run request accepted.",
      },
    ],
    request: buildRequest(),
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    expiresAt: 1_999_999_999,
  };
}
