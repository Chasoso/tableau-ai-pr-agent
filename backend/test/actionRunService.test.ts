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
  updateResult: vi.fn(),
}));

const analysisMock = vi.hoisted(() => ({
  analyzeActionRun: vi.fn(),
}));

const slackMock = vi.hoisted(() => ({
  postActionRun: vi.fn(),
}));

const imageMock = vi.hoisted(() => ({
  generateActionRunPoster: vi.fn(),
}));

const tableauDiagnosticsMock = vi.hoisted(() => ({
  runTableauConnectivityDiagnostics: vi.fn(),
  runTableauConnectivityDiagnosticsWithAuthContext: vi.fn(),
}));

vi.mock("../src/repositories/actionRunRepository", () => ({
  ActionRunRepository: vi.fn(function () {
    return repositoryMock;
  }),
}));

vi.mock("../src/services/actionRunAnalysisService", () => ({
  ActionRunAnalysisService: vi.fn(function () {
    return analysisMock;
  }),
}));

vi.mock("../src/services/slackWebhookService", () => ({
  SlackWebhookService: vi.fn(function () {
    return slackMock;
  }),
}));

vi.mock("../src/services/actionRunImageService", () => ({
  ActionRunImageService: vi.fn(function () {
    return imageMock;
  }),
}));

vi.mock("../src/services/tableauConnectivityDiagnostics", () => ({
  runTableauConnectivityDiagnostics:
    tableauDiagnosticsMock.runTableauConnectivityDiagnostics,
  runTableauConnectivityDiagnosticsWithAuthContext:
    tableauDiagnosticsMock.runTableauConnectivityDiagnosticsWithAuthContext,
}));

describe("ActionRunService", () => {
  const originalTableName = process.env.CHAT_JOBS_TABLE_NAME;
  const originalOwnerHeader = process.env.ACTION_RUN_OWNER_TOKEN_HEADER_NAME;
  const originalTtlSeconds = process.env.ACTION_RUN_TTL_SECONDS;
  const originalLeaseSeconds = process.env.ACTION_RUN_LEASE_SECONDS;
  const originalProgressLimit = process.env.ACTION_RUN_PROGRESS_MESSAGE_LIMIT;
  const originalWorkerFunctionName =
    process.env.ACTION_RUN_WORKER_FUNCTION_NAME;
  const originalImageBaseUrl = process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL;
  const originalImagePrefix = process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:00:00.000Z"));
    process.env.CHAT_JOBS_TABLE_NAME = "chat-jobs";
    process.env.ACTION_RUN_OWNER_TOKEN_HEADER_NAME = "x-action-run-owner-token";
    process.env.ACTION_RUN_TTL_SECONDS = "86400";
    process.env.ACTION_RUN_LEASE_SECONDS = "120";
    process.env.ACTION_RUN_PROGRESS_MESSAGE_LIMIT = "12";
    process.env.ACTION_RUN_WORKER_FUNCTION_NAME = "";
    process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL = "https://images.example.com";
    process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX = "pr-action-images";

    repositoryMock.create.mockReset();
    repositoryMock.get.mockReset();
    repositoryMock.toPublicView.mockReset();
    repositoryMock.claim.mockReset();
    repositoryMock.updateProgress.mockReset();
    repositoryMock.markCompleted.mockReset();
    repositoryMock.markFailed.mockReset();
    repositoryMock.updateResult.mockReset();
    analysisMock.analyzeActionRun.mockReset();
    slackMock.postActionRun.mockReset();
    imageMock.generateActionRunPoster.mockReset();
    tableauDiagnosticsMock.runTableauConnectivityDiagnostics.mockReset();
    tableauDiagnosticsMock.runTableauConnectivityDiagnosticsWithAuthContext.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTableName === undefined) {
      delete process.env.CHAT_JOBS_TABLE_NAME;
    } else {
      process.env.CHAT_JOBS_TABLE_NAME = originalTableName;
    }

    if (originalOwnerHeader === undefined) {
      delete process.env.ACTION_RUN_OWNER_TOKEN_HEADER_NAME;
    } else {
      process.env.ACTION_RUN_OWNER_TOKEN_HEADER_NAME = originalOwnerHeader;
    }

    if (originalTtlSeconds === undefined) {
      delete process.env.ACTION_RUN_TTL_SECONDS;
    } else {
      process.env.ACTION_RUN_TTL_SECONDS = originalTtlSeconds;
    }

    if (originalLeaseSeconds === undefined) {
      delete process.env.ACTION_RUN_LEASE_SECONDS;
    } else {
      process.env.ACTION_RUN_LEASE_SECONDS = originalLeaseSeconds;
    }

    if (originalProgressLimit === undefined) {
      delete process.env.ACTION_RUN_PROGRESS_MESSAGE_LIMIT;
    } else {
      process.env.ACTION_RUN_PROGRESS_MESSAGE_LIMIT = originalProgressLimit;
    }

    if (originalWorkerFunctionName === undefined) {
      delete process.env.ACTION_RUN_WORKER_FUNCTION_NAME;
    } else {
      process.env.ACTION_RUN_WORKER_FUNCTION_NAME = originalWorkerFunctionName;
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
        "X-Action-Run-Owner-Token": "owner-token-123",
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

  it("stores the authenticated user snapshot for worker reuse", async () => {
    repositoryMock.create.mockResolvedValue(undefined);
    const service = new ActionRunService();

    await service.createActionRun({
      request: buildRequest(),
      authenticatedUser: {
        userId: "user-1",
        email: "user@example.com",
        tableauSubject: "user@example.com",
      },
    });

    expect(repositoryMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "authenticated",
        ownerUserId: "user-1",
        authContextSnapshot: expect.objectContaining({
          userId: "user-1",
          email: "user@example.com",
          tableauSubject: "user@example.com",
        }),
      }),
    );
  });

  it("includes runId in action run lifecycle logs", async () => {
    repositoryMock.create.mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // noop
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // noop
    });
    const service = new ActionRunService();

    await service.createActionRun({
      request: buildRequest(),
      headers: {
        "X-Action-Run-Owner-Token": "owner-token-123",
      },
    });

    const payloads = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map(
        ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>,
      )
      .filter((payload) => payload.event === "action_run.created");

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.runId).toBe(payloads[0]?.actionRunId);
    expect(payloads[0]?.requestId).toBeUndefined();
  });

  it("processes an action run with fixed Tableau analysis", async () => {
    repositoryMock.claim.mockResolvedValue(
      buildActionRunRecord({
        ownerType: "authenticated",
        ownerUserId: "user-1",
        ownerKey: "user:user-1",
        authContextSnapshot: {
          userId: "user-1",
          email: "user@example.com",
          tableauSubject: "user@example.com",
        },
      }),
    );
    repositoryMock.updateProgress.mockResolvedValue(buildActionRunRecord());
    repositoryMock.markCompleted.mockResolvedValue(buildActionRunRecord());
    imageMock.generateActionRunPoster.mockResolvedValue({
      imageUrl:
        "https://images.example.com/pr-action-images/action-run-1/poster.svg",
      objectKey: "pr-action-images/action-run-1/poster.svg",
      contentType: "image/svg+xml",
    });
    analysisMock.analyzeActionRun.mockResolvedValue({
      summary: "analysis summary",
      suggestedSlackPostText: "draft text",
      hashtags: ["#Tableau"],
      evidence: ["evidence line"],
      checks: ["check line"],
      analysisSections: [],
      canGeneratePost: true,
      generationBlockers: [],
      safetyReview: {
        status: "pending_manual_review",
        required: true,
        checklist: ["Confirm permissions before posting"],
        notes: ["Human approval is required before any Slack post is sent."],
      },
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
    expect(analysisMock.analyzeActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedUser: expect.objectContaining({
          userId: "user-1",
          email: "user@example.com",
          tableauSubject: "user@example.com",
        }),
      }),
    );
    expect(imageMock.generateActionRunPoster).toHaveBeenCalledTimes(1);
    expect(slackMock.postActionRun).not.toHaveBeenCalled();
    expect(repositoryMock.markCompleted).toHaveBeenCalledWith({
      actionRunId: "action-run-1",
      result: expect.objectContaining({
        summary: "analysis summary",
        imageUrl:
          "https://images.example.com/pr-action-images/action-run-1/poster.svg",
        safetyReview: expect.objectContaining({
          status: "pending_manual_review",
        }),
      }),
    });

    const progressCalls = repositoryMock.updateProgress.mock.calls;
    const lastProgressUpdate = progressCalls[progressCalls.length - 1]?.[1];
    expect(lastProgressUpdate).toEqual(
      expect.objectContaining({
        stage: "completed",
        status: "completed",
        debug: expect.objectContaining({
          safetyReviewStatus: "pending_manual_review",
        }),
      }),
    );
  });

  it("includes Tableau diagnostics in failure logs and failure records", async () => {
    repositoryMock.claim.mockResolvedValue(buildActionRunRecord());
    repositoryMock.updateProgress.mockResolvedValue(buildActionRunRecord());
    repositoryMock.markFailed.mockResolvedValue(buildActionRunRecord());
    analysisMock.analyzeActionRun.mockRejectedValue(
      new Error("Fatal error initializing server info"),
    );
    tableauDiagnosticsMock.runTableauConnectivityDiagnosticsWithAuthContext.mockResolvedValue(
      {
        enabled: true,
        config: {
          serverUrlConfigured: true,
          siteContentUrlConfigured: true,
          apiVersion: "3.25",
          subjectConfigured: true,
          scopesConfigured: ["tableau:content:read"],
          connectedAppConfigured: {
            clientId: true,
            secretId: true,
            secretValue: true,
          },
        },
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

    const service = new ActionRunService();
    await service.processActionRun({
      actionRunId: "action-run-1",
    });

    const failureLog = errorSpy.mock.calls
      .map(
        ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>,
      )
      .find((payload) => payload.event === "action_run.failed");

    expect(failureLog).toBeDefined();
    expect(failureLog).toEqual(
      expect.objectContaining({
        tableauDiagnostics: expect.objectContaining({
          enabled: true,
          reachability: expect.objectContaining({ ok: false }),
        }),
      }),
    );
    expect(repositoryMock.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        actionRunId: "action-run-1",
        error: expect.objectContaining({
          details: expect.objectContaining({
            tableauDiagnostics: expect.objectContaining({
              enabled: true,
              reachability: expect.objectContaining({ ok: false }),
            }),
          }),
        }),
      }),
    );
    expect(
      tableauDiagnosticsMock.runTableauConnectivityDiagnosticsWithAuthContext,
    ).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("sends Slack when approval is granted", async () => {
    repositoryMock.get.mockResolvedValue(
      buildActionRunRecord({
        result: buildActionRunResult(),
      }),
    );
    repositoryMock.updateResult.mockResolvedValue(buildActionRunRecord());
    repositoryMock.toPublicView.mockResolvedValue({
      actionRunId: "action-run-1",
      jobType: "action_run",
      status: "completed",
      stage: "completed",
      progressMessages: [],
      result: buildActionRunResult({
        safetyReview: {
          status: "approved",
          required: true,
          checklist: ["Confirm permissions before posting"],
          notes: ["Human approval is required before any Slack post is sent."],
          reviewedAt: "2026-06-08T00:00:00.000Z",
          reviewerNote: "Looks good.",
        },
      }),
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:01:00.000Z",
      expiresAt: 1_999_999_999,
      ownerType: "anonymous",
    });
    slackMock.postActionRun.mockResolvedValue({
      sent: true,
      skipped: false,
      statusCode: 200,
    });
    const service = new ActionRunService();
    const response = await service.approveActionRun({
      actionRunId: "action-run-1",
      request: {
        approved: true,
        reviewerNote: "Looks good.",
      },
      headers: {
        "X-Action-Run-Owner-Token": "owner-token-123",
      },
    });

    expect(slackMock.postActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Object),
        result: expect.any(Object),
        runId: "action-run-1",
      }),
    );
    expect(repositoryMock.updateResult).toHaveBeenCalled();
    expect(response.slackWebhook).toEqual({
      sent: true,
      skipped: false,
      statusCode: 200,
    });
    expect(response.result?.safetyReview?.status).toBe("approved");
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
        "X-Action-Run-Owner-Token": "owner-token-123",
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
          "X-Action-Run-Owner-Token": "different-owner",
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

function buildActionRunRecord(
  overrides: Partial<ActionRunRecord> = {},
): ActionRunRecord {
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
    ...overrides,
  };
}

function buildActionRunResult(
  overrides: Partial<NonNullable<ActionRunRecord["result"]>> = {},
) {
  return {
    summary: "analysis summary",
    suggestedSlackPostText: "draft text",
    hashtags: ["#Tableau"],
    evidence: ["evidence line"],
    checks: ["check line"],
    analysisSections: [],
    safetyReview: {
      status: "pending_manual_review",
      required: true,
      checklist: ["Confirm permissions before posting"],
      notes: ["Human approval is required before any Slack post is sent."],
    },
    debug: { source: "stub" },
    ...overrides,
  } as never;
}
