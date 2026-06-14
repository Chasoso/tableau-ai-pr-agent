import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/calendarService";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEMO_MODE;
});

describe("CalendarService", () => {
  const originalProvider = process.env.GOOGLE_CALENDAR_PROVIDER;

  beforeEach(() => {
    process.env.GOOGLE_CALENDAR_PROVIDER = "mock";
  });

  afterEach(() => {
    process.env.GOOGLE_CALENDAR_PROVIDER = originalProvider;
  });

  it("selects the best mock calendar event and fetches TechPlay details", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        `<!doctype html>
         <html>
           <head>
             <title>Tableau User Group Tokyo 2026 - TECH PLAY</title>
             <meta property="og:title" content="Tableau User Group Tokyo 2026 - TECH PLAY">
             <meta property="og:description" content="Live event summary.">
             <script type="application/ld+json">
               {
                 "@context": "https://schema.org",
                 "@type": "Event",
                 "name": "Tableau User Group Tokyo 2026",
                 "description": "Live event summary.",
                 "startDate": "2026-06-14T08:00:00+09:00",
                 "endDate": "2026-06-14T10:30:00+09:00"
               }
             </script>
           </head>
           <body>Live event</body>
         </html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      ),
    );

    const service = new CalendarService();
    const response = await service.resolveEventContextFromCalendar({
      postType: "開催中の実況",
      dashboardContext: {
        dashboardName: "Mock Executive Sales Dashboard",
        workbookName: "Sales Workbook",
        worksheets: [{ name: "Summary" }],
        filters: [],
        parameters: [],
        capturedAt: "2026-06-14T03:00:00.000Z",
      },
      venuePhoto: {
        fileName: "venue.jpg",
        sizeLabel: "1.2 MB",
      },
      now: "2026-06-14T03:00:00.000Z",
    });

    expect(response.calendarLookupStatus).toBe("found");
    expect(response.techPlayFetchStatus).toBe("fetched");
    expect(response.selectedEvent?.summary).toBe(
      "Tableau User Group Tokyo 2026",
    );
    expect(response.detectedTechPlayUrl).toBe(
      "https://techplay.jp/event/example",
    );
    expect(response.resolvedEventName).toBe("Tableau User Group Tokyo 2026");
    expect(response.techplayPreview?.eventName).toBe(
      "Tableau User Group Tokyo 2026",
    );
    expect(response.warnings).toEqual(
      expect.arrayContaining([
        "Venue photo added; checking calendar context automatically.",
      ]),
    );
  });

  it("honors a preferred calendar candidate when one is provided", async () => {
    const service = new CalendarService();
    const response = await service.resolveEventContextFromCalendar({
      postType: "事前告知",
      dashboardContext: {
        dashboardName: "Mock Executive Sales Dashboard",
        workbookName: "Sales Workbook",
        worksheets: [{ name: "Summary" }],
        filters: [],
        parameters: [],
        capturedAt: "2026-06-14T03:00:00.000Z",
      },
      preferredEventId: "mock-future-community",
      now: "2026-06-14T03:00:00.000Z",
    });

    expect(response.calendarLookupStatus).toBe("found");
    expect(response.selectedEvent?.eventId).toBe("mock-future-community");
    expect(response.detectedTechPlayUrl).toBe(
      "https://techplay.jp/community/12345",
    );
  });
});
