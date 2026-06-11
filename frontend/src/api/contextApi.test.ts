import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichDashboardContext } from "./contextApi";

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

describe("contextApi", () => {
  it("posts dashboard context with the auth token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        dashboardName: "Dashboard",
        workbookName: "Workbook",
        worksheets: [],
        filters: [],
        parameters: [],
        selectedMarks: [],
        dataSources: [],
        availability: {
          workbookId: "available",
          viewId: "not_supported",
          datasourceFields: "not_implemented",
        },
        contextSource: "tableau-extension",
        capturedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      enrichDashboardContext({ dashboardName: "Dashboard" } as never, "token"),
    ).resolves.toMatchObject({
      dashboardName: "Dashboard",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/context",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
        }),
      }),
    );
  });

  it("rejects non-json responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      enrichDashboardContext({ dashboardName: "Dashboard" } as never),
    ).rejects.toThrow("non-JSON response");
  });
});
