import { describe, expect, it } from "vitest";
import {
  getSearchWindowLabel,
  scoreCalendarEvent,
  selectBestCalendarEvent,
} from "../src/services/calendarScoring";

describe("calendarScoring", () => {
  it("gives the live event the highest score when venue photo is present", () => {
    const now = new Date("2026-06-14T03:00:00.000Z");
    const live = scoreCalendarEvent(
      {
        eventId: "live",
        summary: "Tableau User Group Tokyo 2026",
        description: "Live session https://techplay.jp/event/example",
        location: "Tokyo",
        start: "2026-06-14T02:30:00.000Z",
        end: "2026-06-14T04:30:00.000Z",
      },
      "開催中の実況",
      now,
      { fileName: "venue.jpg" },
    );
    const future = scoreCalendarEvent(
      {
        eventId: "future",
        summary: "Tableau Community Night",
        description: "Future session https://techplay.jp/community/12345",
        location: "Osaka",
        start: "2026-06-14T08:00:00.000Z",
        end: "2026-06-14T10:00:00.000Z",
      },
      "開催中の実況",
      now,
      { fileName: "venue.jpg" },
    );

    expect(live.score).toBeGreaterThan(future.score);
    expect(live.techplayUrls[0]).toBe("https://techplay.jp/event/example");
    expect(live.scoreReasons).toContain("Event is currently in progress.");
  });

  it("respects the preferred event id when selecting a candidate", () => {
    const selected = selectBestCalendarEvent(
      [
        {
          eventId: "a",
          summary: "A",
          start: "2026-06-14T00:00:00.000Z",
          end: "2026-06-14T01:00:00.000Z",
          techplayUrls: [],
          score: 10,
          scoreReasons: [],
        },
        {
          eventId: "b",
          summary: "B",
          start: "2026-06-14T02:00:00.000Z",
          end: "2026-06-14T03:00:00.000Z",
          techplayUrls: [],
          score: 20,
          scoreReasons: [],
        },
      ],
      "a",
    );

    expect(selected?.eventId).toBe("a");
  });

  it("returns a search window label for each post type", () => {
    expect(getSearchWindowLabel("事前告知")).toBe("from today forward");
    expect(getSearchWindowLabel("開催中の実況")).toBe("today and around now");
  });
});
