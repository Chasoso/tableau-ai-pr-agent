import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRunInputImageService } from "../src/services/actionRunInputImageService";

describe("ActionRunInputImageService", () => {
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

  it("stores uploaded input images without attaching a content-disposition header", async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = new ActionRunInputImageService({ send } as never);

    const result = await service.storeActionRunInputImage({
      actionRunId: "action-run-1",
      photo: {
        fileName: "会場写真 2026 #1.jpeg",
        dataUrl: "data:image/jpeg;base64,cGhvdG8=",
        objectKey: "client-input-images/upload-1/venue.jpg",
        contentType: "image/jpeg",
        byteLength: 11,
        source: "uploaded_image",
      },
    });

    expect(result).toEqual({
      objectKey: "client-input-images/upload-1/venue.jpg",
      contentType: "image/jpeg",
      byteLength: 5,
      source: "uploaded_image",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as PutObjectCommand & {
      input: {
        Bucket?: string;
        Key?: string;
        ContentType?: string;
        ContentDisposition?: string;
      };
    };
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe("pr-action-images-bucket");
    expect(command.input.Key).toBe("client-input-images/upload-1/venue.jpg");
    expect(command.input.ContentType).toBe("image/jpeg");
    expect(command.input.ContentDisposition).toBeUndefined();
  });
});
