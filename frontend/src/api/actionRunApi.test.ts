import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionRun, getActionRun } from "./actionRunApi";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("actionRunApi", () => {
  it("creates action runs with the owner token header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        actionRunId: "action-run-1",
        jobType: "action_run",
        status: "queued",
        stage: "queued",
        pollUrl: "/action-runs/action-run-1",
        retryAfterMs: 1500,
        ownerToken: "owner-token-1",
      }),
    );

    await expect(
      createActionRun(
        {
          postType: "\u4e8b\u524d\u544a\u77e5",
          eventName: "Tableau User Group Tokyo 2026",
          techplayUrl: "https://techplay.jp/event/123",
          currentSituation: "The venue is filling up.",
          dashboardContext: {
            dashboardName: "Overview",
            workbookName: "Sales Workbook",
            worksheets: [],
            filters: [],
            parameters: [],
            capturedAt: "2026-06-08T00:00:00.000Z",
          },
        },
        "token-1",
        "owner-1",
      ),
    ).resolves.toEqual({
      actionRunId: "action-run-1",
      jobType: "action_run",
      status: "queued",
      stage: "queued",
      pollUrl: "/action-runs/action-run-1",
      retryAfterMs: 1500,
      ownerToken: "owner-token-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/action-runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "X-Chat-Owner-Token": "owner-1",
        }),
      }),
    );
  });

  it("polls action runs with the owner token header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        actionRunId: "action-run-1",
        jobType: "action_run",
        status: "running",
        stage: "queued",
        progressMessages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        ownerType: "anonymous",
      }),
    );

    await expect(
      getActionRun("action-run-1", undefined, "owner-1"),
    ).resolves.toEqual(
      expect.objectContaining({
        actionRunId: "action-run-1",
        status: "running",
        stage: "queued",
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/action-runs/action-run-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Chat-Owner-Token": "owner-1",
        }),
      }),
    );
  });
});
