import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRunImageService } from "../src/services/actionRunImageService";

describe("ActionRunImageService", () => {
  const originalBucketName = process.env.PR_ACTION_IMAGE_BUCKET_NAME;
  const originalImageBaseUrl = process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL;
  const originalImagePrefix = process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX;

  beforeEach(() => {
    process.env.PR_ACTION_IMAGE_BUCKET_NAME = "pr-action-images-bucket";
    process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL = "https://images.example.com";
    process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX = "pr-action-images";
  });

  afterEach(() => {
    if (originalBucketName === undefined) {
      delete process.env.PR_ACTION_IMAGE_BUCKET_NAME;
    } else {
      process.env.PR_ACTION_IMAGE_BUCKET_NAME = originalBucketName;
    }

    if (originalImageBaseUrl === undefined) {
      delete process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL;
    } else {
      process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL = originalImageBaseUrl;
    }

    if (originalImagePrefix === undefined) {
      delete process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX;
    } else {
      process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX = originalImagePrefix;
    }
  });

  it("uploads an SVG poster and returns its public URL", async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = new ActionRunImageService(
      { send } as never,
      () => "generated-id-123",
    );

    const result = await service.generateActionRunPoster({
      actionRunId: "action-run-1",
      request: buildRequest(),
      result: buildResult(),
    });

    expect(result).toEqual({
      imageUrl:
        "https://images.example.com/pr-action-images/action-run-1/poster.svg",
      objectKey: "pr-action-images/action-run-1/poster.svg",
      contentType: "image/svg+xml",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as PutObjectCommand & {
      input: {
        Bucket?: string;
        Key?: string;
        ContentType?: string;
        ContentDisposition?: string;
        Body?: string;
      };
    };
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe("pr-action-images-bucket");
    expect(command.input.Key).toBe("pr-action-images/action-run-1/poster.svg");
    expect(command.input.ContentType).toBe("image/svg+xml");
    expect(command.input.ContentDisposition).toBe(
      'inline; filename="poster-action-run-1.svg"',
    );
    expect(command.input.Body ?? "").toContain("AI PR ACTION");
    expect(command.input.Body ?? "").toContain("Tableau User Group Tokyo 2026");
    expect(command.input.Body ?? "").toContain("事前告知");
    expect(command.input.Body ?? "").toContain("盛り上がっています");
    expect(command.input.Body ?? "").toContain("#Tableau");
  });

  it("skips generation when the bucket name is not configured", async () => {
    process.env.PR_ACTION_IMAGE_BUCKET_NAME = "";
    const send = vi.fn();
    const service = new ActionRunImageService(
      { send } as never,
      () => "generated-id-123",
    );

    const result = await service.generateActionRunPoster({
      actionRunId: "action-run-1",
      request: buildRequest(),
      result: buildResult(),
    });

    expect(result).toMatchObject({
      contentType: "image/svg+xml",
      objectKey: "demo/action-run-1/poster.svg",
    });
    expect(result?.imageUrl).toContain("data:image/svg+xml");
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a deterministic fallback when the upload fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("s3 unavailable"));
    const service = new ActionRunImageService(
      { send } as never,
      () => "generated-id-123",
    );

    const result = await service.generateActionRunPoster({
      actionRunId: "action-run-1",
      request: buildRequest(),
      result: buildResult(),
    });

    expect(result).toMatchObject({
      contentType: "image/svg+xml",
      objectKey: "demo/action-run-1/poster.svg",
    });
    expect(result?.imageUrl).toContain("data:image/svg+xml");
    expect(send).toHaveBeenCalledTimes(1);
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
    summary: "The room is lively and turnout is strong.",
    suggestedSlackPostText: "draft text",
    hashtags: ["#Tableau", "#TechPlay", "#Community"],
    evidence: ["Attendance is above target", "Photos suggest high energy"],
    checks: ["Confirm permissions before posting"],
    analysisSections: [],
    debug: { source: "stub" },
    imageCaption: "盛り上がっています",
  } as never;
}
