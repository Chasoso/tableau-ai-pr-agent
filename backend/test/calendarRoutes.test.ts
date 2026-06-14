import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calendarMocks = vi.hoisted(() => ({
  resolveEventContextFromCalendar: vi.fn(),
}));

vi.mock("../src/services/calendarService", () => ({
  CalendarService: vi.fn().mockImplementation(() => calendarMocks),
}));

import { handler } from "../src/handlers/chatHandler";

describe("calendar resolve routes", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;

  beforeEach(() => {
    delete process.env.AUTH_REQUIRED;
    calendarMocks.resolveEventContextFromCalendar.mockReset();
  });

  afterEach(() => {
    if (originalAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
      return;
    }

    process.env.AUTH_REQUIRED = originalAuthRequired;
  });

  it("returns a resolved event context", async () => {
    calendarMocks.resolveEventContextFromCalendar.mockResolvedValue({
      provider: "mock",
      calendarLookupStatus: "found",
      techPlayFetchStatus: "fetched",
      manualTechPlayMode: false,
      searchWindowLabel: "today and around now",
      selectedEvent: {
        eventId: "mock-current-tableau-user-group",
        summary: "Tableau User Group Tokyo 2026",
        start: "2026-06-14T02:30:00.000Z",
        end: "2026-06-14T04:30:00.000Z",
        techplayUrls: ["https://techplay.jp/event/example"],
        score: 100,
        scoreReasons: ["TechPlay URL detected."],
      },
      candidates: [],
      detectedTechPlayUrl: "https://techplay.jp/event/example",
      techplayPreview: {
        techplayUrl: "https://techplay.jp/event/example",
        eventName: "Tableau User Group Tokyo 2026",
        eventDateText: "2026/06/14 11:30",
        summary: "Live summary.",
        sourceTitle: "Tableau User Group Tokyo 2026 - TECH PLAY",
        sourceDescription: "Live summary.",
        extractedFrom: "jsonld",
      },
      resolvedEventName: "Tableau User Group Tokyo 2026",
      warnings: [],
      notes: [],
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/calendar/resolve",
      headers: {},
      body: JSON.stringify({
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
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      provider: "mock",
      calendarLookupStatus: "found",
      techPlayFetchStatus: "fetched",
      resolvedEventName: "Tableau User Group Tokyo 2026",
    });
    expect(calendarMocks.resolveEventContextFromCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        postType: "開催中の実況",
        venuePhoto: {
          fileName: "venue.jpg",
        },
      }),
    );
  });

  it("rejects invalid calendar resolve requests", async () => {
    const response = await handler({
      httpMethod: "POST",
      rawPath: "/calendar/resolve",
      headers: {},
      body: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      message: "postType is required.",
    });
  });
});
