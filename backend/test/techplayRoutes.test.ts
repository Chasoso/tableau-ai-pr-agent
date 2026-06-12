import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const techPlayMocks = vi.hoisted(() => ({
  previewTechPlayEvent: vi.fn(),
}));

vi.mock("../src/services/techplayService", () => ({
  TechPlayService: vi.fn().mockImplementation(() => techPlayMocks),
}));

import { handler } from "../src/handlers/chatHandler";

describe("techplay preview routes", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;

  beforeEach(() => {
    delete process.env.AUTH_REQUIRED;
    techPlayMocks.previewTechPlayEvent.mockReset();
  });

  afterEach(() => {
    if (originalAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = originalAuthRequired;
    }
  });

  it("returns a preview for a TechPlay URL", async () => {
    techPlayMocks.previewTechPlayEvent.mockResolvedValue({
      techplayUrl: "https://techplay.jp/event/983048",
      eventName: "Sample Event",
      eventDateText: "2025/08/08 18:30",
      summary: "Sample summary.",
      sourceTitle: "Sample Event - TECH PLAY",
      sourceDescription: "Sample summary.",
      extractedFrom: "jsonld",
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/techplay/preview",
      headers: {},
      body: JSON.stringify({
        techplayUrl: "https://techplay.jp/event/983048",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        eventName: "Sample Event",
        extractedFrom: "jsonld",
      }),
    );
    expect(techPlayMocks.previewTechPlayEvent).toHaveBeenCalledWith({
      techplayUrl: "https://techplay.jp/event/983048",
    });
  });

  it("rejects invalid TechPlay URLs before calling the service", async () => {
    const response = await handler({
      httpMethod: "POST",
      rawPath: "/techplay/preview",
      headers: {},
      body: JSON.stringify({
        techplayUrl: "https://example.com/event/1",
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      message: "techplayUrl must point to techplay.jp.",
    });
    expect(techPlayMocks.previewTechPlayEvent).not.toHaveBeenCalled();
  });
});
