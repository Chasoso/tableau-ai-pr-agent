import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarService } from "../src/services/googleCalendarService";
import {
  clearGoogleCalendarTokenKeyCacheForTest,
  encryptGoogleToken,
} from "../src/security/googleCalendarTokenCrypto";

const fetchMock = vi.fn();
const mocks = vi.hoisted(() => ({
  getSecureStringParameter: vi.fn(),
}));

vi.mock("../src/aws/ssm", () => ({
  getSecureStringParameter: mocks.getSecureStringParameter,
}));

describe("GoogleCalendarService", () => {
  const originalEnv = {
    GOOGLE_CALENDAR_PROVIDER: process.env.GOOGLE_CALENDAR_PROVIDER,
    GOOGLE_CALENDAR_CALENDAR_ID: process.env.GOOGLE_CALENDAR_CALENDAR_ID,
    GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY_PARAM:
      process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY_PARAM,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mocks.getSecureStringParameter.mockReset();
    mocks.getSecureStringParameter.mockResolvedValue(
      "12345678901234567890123456789012",
    );
    process.env.GOOGLE_CALENDAR_PROVIDER = "google";
    process.env.GOOGLE_CALENDAR_CALENDAR_ID = "primary@example.com";
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY_PARAM =
      "/test/google-calendar/token-encryption-key";
    clearGoogleCalendarTokenKeyCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.GOOGLE_CALENDAR_PROVIDER = originalEnv.GOOGLE_CALENDAR_PROVIDER;
    process.env.GOOGLE_CALENDAR_CALENDAR_ID =
      originalEnv.GOOGLE_CALENDAR_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_CLIENT_ID =
      originalEnv.GOOGLE_CALENDAR_CLIENT_ID;
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET =
      originalEnv.GOOGLE_CALENDAR_CLIENT_SECRET;
    process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY_PARAM =
      originalEnv.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY_PARAM;
    clearGoogleCalendarTokenKeyCacheForTest();
  });

  it("fetches Google Calendar events from the user's stored connection", async () => {
    const encryptedRefreshToken = await encryptGoogleToken("refresh-token");
    const repository = {
      getConnection: vi.fn().mockResolvedValue({
        userId: "user-123",
        connectionId: "GOOGLE_CALENDAR#DEFAULT",
        refreshTokenCiphertext: encryptedRefreshToken.ciphertext,
        refreshTokenIv: encryptedRefreshToken.iv,
        refreshTokenAuthTag: encryptedRefreshToken.authTag,
        createdAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-14T00:00:00.000Z",
        lastUsedAt: "2026-06-14T00:00:00.000Z",
        status: "connected",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      }),
      putConnection: vi.fn().mockResolvedValue(undefined),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "event-1",
                summary: "Tableau User Group Tokyo 2026",
                description: "https://techplay.jp/event/example",
                location: "Tokyo",
                start: { dateTime: "2026-06-14T02:30:00.000Z" },
                end: { dateTime: "2026-06-14T04:30:00.000Z" },
                htmlLink:
                  "https://calendar.google.com/calendar/u/0/r/eventedit/event-1",
                attachments: [{ fileUrl: "https://techplay.jp/event/example" }],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );

    const service = new GoogleCalendarService(repository as never);
    const candidates = await service.searchCalendarEvents({
      postType: "\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1",
      now: new Date("2026-06-14T03:00:00.000Z"),
      authenticatedUser: { userId: "user-123" },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.eventId).toBe("event-1");
    expect(candidates[0]?.summary).toBe("Tableau User Group Tokyo 2026");
    expect(candidates[0]?.start).toBe("2026-06-14T02:30:00.000Z");
    expect(candidates[0]?.techplayUrls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repository.getConnection).toHaveBeenCalledWith("user-123");
    expect(repository.putConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        status: "connected",
      }),
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "calendar/v3/calendars/primary%40example.com/events",
    );
  });

  it("requires a user connection and does not fall back to a shared refresh token", async () => {
    const repository = {
      getConnection: vi.fn().mockResolvedValue(null),
      putConnection: vi.fn().mockResolvedValue(undefined),
    };

    const service = new GoogleCalendarService(repository as never);

    await expect(
      service.searchCalendarEvents({
        postType: "\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1",
        now: new Date("2026-06-14T03:00:00.000Z"),
        authenticatedUser: { userId: "user-123" },
      }),
    ).rejects.toThrow("Google Calendar is not connected for this user.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.putConnection).not.toHaveBeenCalled();
  });
});
