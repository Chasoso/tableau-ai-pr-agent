import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackWebhookService } from "../src/services/slackWebhookService";
import type { ActionRunRequest, ActionRunResult } from "../src/types/actionRun";

describe("SlackWebhookService", () => {
  const originalWebhookUrl = process.env.SLACK_INCOMING_WEBHOOK_URL;
  const originalDemoMode = process.env.DEMO_MODE;

  beforeEach(() => {
    process.env.SLACK_INCOMING_WEBHOOK_URL =
      "https://hooks.slack.com/services/T000/B000/SECRET";
    delete process.env.DEMO_MODE;
  });

  afterEach(() => {
    if (originalWebhookUrl === undefined) {
      delete process.env.SLACK_INCOMING_WEBHOOK_URL;
    } else {
      process.env.SLACK_INCOMING_WEBHOOK_URL = originalWebhookUrl;
    }

    if (originalDemoMode === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = originalDemoMode;
    }
  });

  it("posts only the approved post text and image to the Slack webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const service = new SlackWebhookService(fetchMock as never);

    const response = await service.postActionRun({
      request: buildRequest(),
      result: buildResult(),
    });

    expect(response).toEqual({
      sent: true,
      skipped: false,
      statusCode: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(process.env.SLACK_INCOMING_WEBHOOK_URL);
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    const payload = JSON.parse((init as RequestInit).body as string) as {
      text: string;
      blocks: Array<{ type: string; [key: string]: unknown }>;
    };
    expect(payload.text).toBe("draft text");
    expect(payload.blocks).toHaveLength(2);
    expect(payload.blocks[0]).toEqual(
      expect.objectContaining({
        type: "section",
        text: expect.objectContaining({
          type: "mrkdwn",
          text: "draft text",
        }),
      }),
    );
    expect(payload.blocks[1]).toEqual(
      expect.objectContaining({
        type: "image",
        image_url:
          "https://images.example.com/pr-action-images/action-run-1/poster.svg",
        alt_text: expect.stringContaining("Tableau User Group Tokyo 2026"),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("Draft post");
    expect(JSON.stringify(payload)).not.toContain("Summary");
    expect(JSON.stringify(payload)).not.toContain("Human review");
    expect(JSON.stringify(payload)).not.toContain("Evidence");
    expect(JSON.stringify(payload)).not.toContain("Checks");
    expect(JSON.stringify(payload)).not.toContain("Tableau signals");
  });

  it("prefers edited text over the selected suggestion text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const service = new SlackWebhookService(fetchMock as never);

    await service.postActionRun({
      request: buildRequest(),
      result: buildResult(),
      selectedSuggestionText: "selected suggestion",
      editedText: "edited suggestion",
    });

    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse((init as RequestInit).body as string) as {
      text: string;
      blocks: Array<{ type: string; [key: string]: unknown }>;
    };

    expect(payload.text).toBe("edited suggestion");
    expect(
      payload.blocks[0] &&
        "text" in payload.blocks[0] &&
        (payload.blocks[0].text as { text?: string }).text,
    ).toBe("edited suggestion");
  });

  it("skips posting when no webhook is configured", async () => {
    delete process.env.SLACK_INCOMING_WEBHOOK_URL;
    const service = new SlackWebhookService(vi.fn() as never);

    const response = await service.postActionRun({
      request: buildRequest(),
      result: buildResult(),
    });

    expect(response).toEqual({ sent: false, skipped: true });
  });

  it("skips posting in demo mode", async () => {
    process.env.DEMO_MODE = "true";
    const fetchMock = vi.fn();
    const service = new SlackWebhookService(fetchMock as never);

    const response = await service.postActionRun({
      request: buildRequest(),
      result: buildResult(),
    });

    expect(response).toEqual({ sent: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits data URL images from the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const service = new SlackWebhookService(fetchMock as never);
    const result = buildResult();

    await service.postActionRun({
      request: buildRequest(),
      result: {
        ...result,
        imageUrl: "data:image/svg+xml;charset=utf-8,hello",
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse((init as RequestInit).body as string) as {
      blocks: Array<{ type: string; [key: string]: unknown }>;
    };
    expect(payload.blocks.some((block) => block.type === "image")).toBe(false);
  });
});

function buildRequest(): ActionRunRequest {
  return {
    postType: "\u4e8b\u524d\u544a\u77e5",
    eventName: "Tableau User Group Tokyo 2026",
    techplayUrl: "https://techplay.jp/event/123",
    currentSituation: "The venue is filling up.",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  };
}

function buildResult(): ActionRunResult {
  return {
    summary: "analysis summary",
    suggestedSlackPostText: "draft text",
    hashtags: ["#Tableau"],
    evidence: ["evidence line"],
    checks: ["check line"],
    imageUrl:
      "https://images.example.com/pr-action-images/action-run-1/poster.svg",
    analysisSections: [
      {
        key: "post_type_distribution",
        title: "Post type distribution",
        question: "Question",
        summary: "Summary",
        rows: [{ label: "事前告知", value: 12 }],
      },
    ],
  };
}
