import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarService } from "../src/services/googleCalendarService";

const fetchMock = vi.fn();

describe("GoogleCalendarService", () => {
  const originalEnv = {
    GOOGLE_CALENDAR_PROVIDER: process.env.GOOGLE_CALENDAR_PROVIDER,
    GOOGLE_CALENDAR_CALENDAR_ID: process.env.GOOGLE_CALENDAR_CALENDAR_ID,
    GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_CALENDAR_REFRESH_TOKEN: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    process.env.GOOGLE_CALENDAR_PROVIDER = "google";
    process.env.GOOGLE_CALENDAR_CALENDAR_ID = "primary@example.com";
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "refresh-token";
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
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN =
      originalEnv.GOOGLE_CALENDAR_REFRESH_TOKEN;
  });

  it("fetches Google Calendar events and maps them into candidates", async () => {
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
                attachments: [
                  { fileUrl: "https://techplay.jp/event/example" },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );

    const service = new GoogleCalendarService();
    const candidates = await service.searchCalendarEvents({
      postType: "開催中の実況",
      now: new Date("2026-06-14T03:00:00.000Z"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.eventId).toBe("event-1");
    expect(candidates[0]?.summary).toBe("Tableau User Group Tokyo 2026");
    expect(candidates[0]?.start).toBe("2026-06-14T02:30:00.000Z");
    expect(candidates[0]?.techplayUrls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "calendar/v3/calendars/primary%40example.com/events",
    );
  });
});
