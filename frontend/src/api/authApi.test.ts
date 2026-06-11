import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPopupAuthStatus, startPopupAuth } from "./authApi";

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

describe("authApi", () => {
  it("starts popup auth with the redirectAfter payload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        transactionId: "txn-1",
        pollToken: "poll-1",
        authorizationUrl: "https://example.com",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      startPopupAuth({ redirectAfter: "/dashboard" }),
    ).resolves.toEqual({
      transactionId: "txn-1",
      pollToken: "poll-1",
      authorizationUrl: "https://example.com",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/cognito/popup/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ redirectAfter: "/dashboard" }),
      }),
    );
  });

  it("returns popup auth status when the request succeeds", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "completed",
        session: {
          accessToken: "token-1",
          idToken: "id-1",
          refreshToken: "refresh-1",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    await expect(getPopupAuthStatus("txn-1", "poll-1")).resolves.toEqual({
      status: "completed",
      session: {
        accessToken: "token-1",
        idToken: "id-1",
        refreshToken: "refresh-1",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/auth/cognito/popup/status");
    expect(String(url)).toContain("transactionId=txn-1");
    expect(options).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { "X-Auth-Poll-Token": "poll-1" },
      }),
    );
  });

  it("does not throw when the popup auth status response is failed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { status: "failed", message: "popup rejected" },
        { status: 400 },
      ),
    );

    await expect(getPopupAuthStatus("txn-1", "poll-1")).resolves.toEqual({
      status: "failed",
      message: "popup rejected",
    });
  });

  it("throws the response message when popup auth status fails unexpectedly", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "not ready yet" }, { status: 500 }),
    );

    await expect(getPopupAuthStatus("txn-1", "poll-1")).rejects.toThrow(
      "not ready yet",
    );
  });
});
