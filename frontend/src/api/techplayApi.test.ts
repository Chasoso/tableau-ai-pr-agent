import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewTechPlayEvent } from "./techplayApi";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("techplayApi", () => {
  it("loads techplay previews with auth and owner headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        techplayUrl: "https://techplay.jp/event/983048",
        eventName: "Sample Event",
        eventDateText: "2025/08/08 18:30",
        summary: "Sample summary.",
        sourceTitle: "Sample Event - TECH PLAY",
        sourceDescription: "Sample summary.",
        extractedFrom: "jsonld",
      }),
    );

    await expect(
      previewTechPlayEvent(
        { techplayUrl: "https://techplay.jp/event/983048" },
        "token-1",
        "owner-1",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        eventName: "Sample Event",
        extractedFrom: "jsonld",
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/techplay/preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "X-Chat-Owner-Token": "owner-1",
        }),
      }),
    );
  });
});
