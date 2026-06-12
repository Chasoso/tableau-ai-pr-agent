import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TechPlayService } from "../src/services/techplayService";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TechPlayService", () => {
  it("extracts event metadata from JSON-LD", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        `<!doctype html>
         <html>
           <head>
             <title>Sample Event - TECH PLAY</title>
             <meta property="og:title" content="Sample Event - TECH PLAY">
             <meta property="og:description" content="Sample summary.">
             <script type="application/ld+json">
               {
                 "@context": "https://schema.org",
                 "@type": "Event",
                 "name": "Sample Event",
                 "description": "Sample summary.",
                 "startDate": "2025-08-08T18:30:00+09:00",
                 "endDate": "2025-08-08T20:45:00+09:00"
               }
             </script>
           </head>
           <body>Sample body.</body>
         </html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      ),
    );

    const service = new TechPlayService();
    const preview = await service.previewTechPlayEvent({
      techplayUrl: "https://techplay.jp/event/983048",
    });

    expect(preview.techplayUrl).toBe("https://techplay.jp/event/983048");
    expect(preview.eventName).toBe("Sample Event");
    expect(preview.summary).toBe("Sample summary.");
    expect(preview.extractedFrom).toBe("jsonld");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://techplay.jp/event/983048",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/html,application/xhtml+xml",
        }),
      }),
    );
  });

  it("rejects non-TechPlay URLs", async () => {
    const service = new TechPlayService();

    await expect(
      service.previewTechPlayEvent({
        techplayUrl: "https://example.com/event/1",
      }),
    ).rejects.toThrow("TechPlay URL must point to techplay.jp.");
  });
});
