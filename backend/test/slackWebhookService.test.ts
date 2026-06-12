import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackWebhookService } from "../src/services/slackWebhookService";

describe("SlackWebhookService", () => {
  const originalWebhookUrl = process.env.SLACK_INCOMING_WEBHOOK_URL;

  beforeEach(() => {
    process.env.SLACK_INCOMING_WEBHOOK_URL =
      "https://hooks.slack.com/services/T000/B000/SECRET";
  });

  afterEach(() => {
    if (originalWebhookUrl === undefined) {
      delete process.env.SLACK_INCOMING_WEBHOOK_URL;
    } else {
      process.env.SLACK_INCOMING_WEBHOOK_URL = originalWebhookUrl;
    }
  });

  it("posts a formatted payload to the Slack webhook", async () => {
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
    expect(payload.text).toContain("Tableau User Group Tokyo 2026");
    expect(payload.blocks.length).toBeGreaterThan(0);
    expect(payload.blocks.some((block) => block.type === "image")).toBe(true);
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
});

function buildRequest() {
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
  } as never;
}

function buildResult() {
  return {
    summary: "analysis summary",
    suggestedSlackPostText: "draft text",
    hashtags: ["#Tableau"],
    evidence: ["evidence line"],
    checks: ["check line"],
    imageUrl:
      "https://images.example.com/pr-action-images/action-run-1/poster.png",
    analysisSections: [
      {
        key: "post_type_distribution",
        title: "Post type distribution",
        question: "Question",
        summary: "Summary",
        rows: [{ label: "事前告知", value: 12 }],
      },
    ],
  } as never;
}
