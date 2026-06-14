import { describe, expect, it } from "vitest";
import { extractTechPlayUrlsFromCalendarEvent } from "../src/services/calendarTechPlayExtractor";

describe("calendarTechPlayExtractor", () => {
  it("extracts and prioritizes TechPlay URLs from event fields", () => {
    const urls = extractTechPlayUrlsFromCalendarEvent({
      summary: "Tableau User Group",
      description:
        "See https://example.com and https://techplay.jp/community/12345",
      location: "https://techplay.jp/event/abc",
      htmlLink: "https://calendar.google.com/calendar/u/0/r/eventedit/mock",
      attachments: [
        { fileUrl: "https://techplay.jp/event/abc" },
        { url: "https://techplay.jp/community/12345" },
      ],
      conferenceData: {
        entryPoints: [{ uri: "https://techplay.jp/other/999" }],
      },
    });

    expect(urls).toEqual([
      "https://techplay.jp/event/abc",
      "https://techplay.jp/community/12345",
      "https://techplay.jp/other/999",
    ]);
  });
});
