import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionRunMocks = vi.hoisted(() => ({
  createActionRun: vi.fn(),
  getActionRun: vi.fn(),
  approveActionRun: vi.fn(),
  postActionRunToBluesky: vi.fn(),
}));

vi.mock("../src/services/actionRunService", () => ({
  ActionRunService: vi.fn().mockImplementation(() => actionRunMocks),
}));

import { handler } from "../src/handlers/chatHandler";

describe("action run routes", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;

  beforeEach(() => {
    delete process.env.AUTH_REQUIRED;
    actionRunMocks.createActionRun.mockReset();
    actionRunMocks.getActionRun.mockReset();
    actionRunMocks.approveActionRun.mockReset();
    actionRunMocks.postActionRunToBluesky.mockReset();
  });

  afterEach(() => {
    if (originalAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = originalAuthRequired;
    }
  });

  it("creates an action run and returns 202 with the actionRunId", async () => {
    actionRunMocks.createActionRun.mockResolvedValue({
      actionRunId: "action-run-123",
      jobType: "action_run",
      status: "queued",
      stage: "queued",
      pollUrl: "/action-runs/action-run-123",
      retryAfterMs: 1500,
      ownerToken: "owner-token",
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/action-runs",
      headers: {},
      body: JSON.stringify({
        postType: "\u4e8b\u524d\u544a\u77e5",
        eventName: "Tableau User Group Tokyo 2026",
        techplayUrl: "https://techplay.jp/event/123",
        currentSituation: "The venue is filling up.",
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
      actionRunId: "action-run-123",
      jobType: "action_run",
      status: "queued",
      stage: "queued",
      pollUrl: "/action-runs/action-run-123",
      retryAfterMs: 1500,
      ownerToken: "owner-token",
    });
    expect(actionRunMocks.createActionRun).toHaveBeenCalledTimes(1);
  });

  it("fetches an action run by id", async () => {
    actionRunMocks.getActionRun.mockResolvedValue({
      actionRunId: "action-run-123",
      jobType: "action_run",
      status: "running",
      stage: "queued",
      progressMessages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ownerType: "anonymous",
    });

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/action-runs/action-run-123",
      headers: {},
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      actionRunId: "action-run-123",
      jobType: "action_run",
      status: "running",
      ownerType: "anonymous",
    });
    expect(actionRunMocks.getActionRun).toHaveBeenCalledTimes(1);
    expect(actionRunMocks.getActionRun).toHaveBeenCalledWith({
      actionRunId: "action-run-123",
      authenticatedUser: undefined,
      headers: {},
    });
  });

  it("returns 403 when the current user does not own the action run", async () => {
    actionRunMocks.getActionRun.mockRejectedValue(
      new Error("You do not have access to this action run."),
    );

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/action-runs/action-run-456",
      headers: {},
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      message: "You do not have access to this action run.",
    });
  });

  it("returns 404 when the action run is missing", async () => {
    actionRunMocks.getActionRun.mockRejectedValue(
      new Error("Action run not found."),
    );

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/action-runs/action-run-missing",
      headers: {},
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      message: "Action run not found.",
    });
  });

  it("approves an action run and returns the Slack result", async () => {
    actionRunMocks.approveActionRun.mockResolvedValue({
      actionRunId: "action-run-123",
      jobType: "action_run",
      status: "completed",
      stage: "completed",
      progressMessages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ownerType: "anonymous",
      slackWebhook: {
        sent: true,
        skipped: false,
        statusCode: 200,
      },
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/action-runs/action-run-123/approval",
      headers: {},
      body: JSON.stringify({
        approved: true,
        reviewerNote: "Looks good.",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      actionRunId: "action-run-123",
      jobType: "action_run",
      slackWebhook: {
        sent: true,
        skipped: false,
        statusCode: 200,
      },
    });
    expect(actionRunMocks.approveActionRun).toHaveBeenCalledTimes(1);
    expect(actionRunMocks.approveActionRun).toHaveBeenCalledWith({
      actionRunId: "action-run-123",
      request: {
        approved: true,
        reviewerNote: "Looks good.",
      },
      authenticatedUser: undefined,
      headers: {},
      requestId: undefined,
    });
  });

  it("posts an approved action run to Bluesky", async () => {
    actionRunMocks.postActionRunToBluesky.mockResolvedValue({
      actionRunId: "action-run-123",
      jobType: "action_run",
      status: "completed",
      stage: "completed",
      progressMessages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ownerType: "anonymous",
      blueskyPost: {
        sent: true,
        skipped: false,
        statusCode: 200,
        postUri: "at://did:plc:abc123/app.bsky.feed.post/3lzwxyz",
        cid: "cid-123",
      },
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/action-runs/action-run-123/bluesky-post",
      headers: {},
      body: JSON.stringify({
        selectedSuggestionText: "Bluesky post draft",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      actionRunId: "action-run-123",
      blueskyPost: {
        sent: true,
        skipped: false,
        statusCode: 200,
        postUri: "at://did:plc:abc123/app.bsky.feed.post/3lzwxyz",
        cid: "cid-123",
      },
    });
    expect(actionRunMocks.postActionRunToBluesky).toHaveBeenCalledTimes(1);
    expect(actionRunMocks.postActionRunToBluesky).toHaveBeenCalledWith({
      actionRunId: "action-run-123",
      request: {
        selectedSuggestionText: "Bluesky post draft",
      },
      authenticatedUser: undefined,
      headers: {},
      requestId: undefined,
    });
  });
});
