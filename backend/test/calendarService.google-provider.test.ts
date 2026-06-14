import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleMocks = vi.hoisted(() => ({
  searchCalendarEvents: vi.fn(),
}));

const techPlayMocks = vi.hoisted(() => ({
  previewTechPlayEvent: vi.fn(),
}));

vi.mock("../src/services/googleCalendarService", () => ({
  GoogleCalendarService: vi.fn().mockImplementation(() => googleMocks),
}));

vi.mock("../src/services/techplayService", () => ({
  TechPlayService: vi.fn().mockImplementation(() => techPlayMocks),
}));

import { CalendarService } from "../src/services/calendarService";

describe("CalendarService google provider", () => {
  const originalEnv = {
    GOOGLE_CALENDAR_PROVIDER: process.env.GOOGLE_CALENDAR_PROVIDER,
    GOOGLE_CALENDAR_CALENDAR_ID: process.env.GOOGLE_CALENDAR_CALENDAR_ID,
    GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_CALENDAR_REFRESH_TOKEN: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
  };

  beforeEach(() => {
    process.env.GOOGLE_CALENDAR_PROVIDER = "google";
    process.env.GOOGLE_CALENDAR_CALENDAR_ID = "primary@example.com";
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "refresh-token";
    googleMocks.searchCalendarEvents.mockReset();
    techPlayMocks.previewTechPlayEvent.mockReset();
  });

  afterEach(() => {
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

  it("routes calendar resolution through the Google provider", async () => {
    googleMocks.searchCalendarEvents.mockResolvedValue([
      {
        eventId: "event-1",
        summary: "Tableau User Group Tokyo 2026",
        description: "https://techplay.jp/event/example",
        location: "Tokyo",
        start: "2026-06-14T02:30:00.000Z",
        end: "2026-06-14T04:30:00.000Z",
        htmlLink:
          "https://calendar.google.com/calendar/u/0/r/eventedit/event-1",
        techplayUrls: ["https://techplay.jp/event/example"],
        score: 20,
        scoreReasons: ["mock score"],
      },
    ]);
    techPlayMocks.previewTechPlayEvent.mockResolvedValue({
      techplayUrl: "https://techplay.jp/event/example",
      eventName: "Tableau User Group Tokyo 2026",
      eventDateText: "2026/06/14 11:30",
      summary: "Live summary.",
      sourceTitle: "Tableau User Group Tokyo 2026 - TECH PLAY",
      sourceDescription: "Live summary.",
      extractedFrom: "jsonld",
    });

    const service = new CalendarService();
    const response = await service.resolveEventContextFromCalendar({
      postType: "開催中の実況",
      dashboardContext: {
        dashboardName: "Mock Executive Sales Dashboard",
        workbookName: "Sales Workbook",
        worksheets: [{ name: "Summary" }],
        filters: [],
        parameters: [],
        capturedAt: "2026-06-14T00:00:00.000Z",
      },
      venuePhoto: {
        fileName: "venue.jpg",
        sizeLabel: "1.2 MB",
      },
      now: "2026-06-14T03:00:00.000Z",
    });

    expect(googleMocks.searchCalendarEvents).toHaveBeenCalled();
    expect(techPlayMocks.previewTechPlayEvent).toHaveBeenCalledWith({
      techplayUrl: "https://techplay.jp/event/example",
    });
    expect(response.provider).toBe("google");
    expect(response.calendarLookupStatus).toBe("found");
    expect(response.techPlayFetchStatus).toBe("fetched");
    expect(response.selectedEvent?.eventId).toBe("event-1");
  });
});
