import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlueskyPostService } from "../src/services/blueskyPostService";

const fetchMock = vi.fn();

describe("BlueskyPostService", () => {
  const originalIdentifier = process.env.BLUESKY_IDENTIFIER;
  const originalAppPassword = process.env.BLUESKY_APP_PASSWORD;
  const originalServiceUrl = process.env.BLUESKY_SERVICE_URL;
  const originalDemoMode = process.env.DEMO_MODE;

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.BLUESKY_IDENTIFIER = "user@example.com";
    process.env.BLUESKY_APP_PASSWORD = "app-password-123";
    process.env.BLUESKY_SERVICE_URL = "https://bsky.social/";
    delete process.env.DEMO_MODE;
  });

  afterEach(() => {
    if (originalIdentifier === undefined) {
      delete process.env.BLUESKY_IDENTIFIER;
    } else {
      process.env.BLUESKY_IDENTIFIER = originalIdentifier;
    }

    if (originalAppPassword === undefined) {
      delete process.env.BLUESKY_APP_PASSWORD;
    } else {
      process.env.BLUESKY_APP_PASSWORD = originalAppPassword;
    }

    if (originalServiceUrl === undefined) {
      delete process.env.BLUESKY_SERVICE_URL;
    } else {
      process.env.BLUESKY_SERVICE_URL = originalServiceUrl;
    }

    if (originalDemoMode === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = originalDemoMode;
    }
  });

  it("creates a session and posts a record with app password auth", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessJwt: "jwt-123",
            did: "did:plc:abc123",
            handle: "user.bsky.social",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uri: "at://did:plc:abc123/app.bsky.feed.post/3lzwxyz",
            cid: "cid-123",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const service = new BlueskyPostService(fetchMock as typeof fetch);
    await expect(
      service.postText({
        text: "Hello Bluesky",
        runId: "run-1",
      }),
    ).resolves.toEqual({
      sent: true,
      skipped: false,
      statusCode: 200,
      postUri: "at://did:plc:abc123/app.bsky.feed.post/3lzwxyz",
      cid: "cid-123",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "user@example.com",
          password: "app-password-123",
        }),
      }),
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-123",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("skips posting when credentials are missing", async () => {
    delete process.env.BLUESKY_IDENTIFIER;
    delete process.env.BLUESKY_APP_PASSWORD;

    const service = new BlueskyPostService(fetchMock as typeof fetch);
    await expect(
      service.postText({
        text: "Hello Bluesky",
        runId: "run-1",
      }),
    ).resolves.toEqual({
      sent: false,
      skipped: true,
      error: "Bluesky credentials are not configured.",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
