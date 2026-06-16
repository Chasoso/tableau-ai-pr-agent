import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "../aws/s3";
import { getConfig } from "../config";
import { logInfo } from "../logging";

export type StoredActionRunInputImage = {
  objectKey: string;
  contentType: string;
  byteLength: number;
  source: "uploaded_image" | "existing_object";
  width?: number;
  height?: number;
};

export type ResolvedActionRunInputImage = StoredActionRunInputImage & {
  bytes: Uint8Array;
};

export class ActionRunInputImageService {
  constructor(private readonly s3Client = getS3Client()) {}

  async storeActionRunInputImage(input: {
    actionRunId: string;
    photo: {
      fileName?: string;
      dataUrl?: string;
      objectKey?: string;
      contentType?: string;
      byteLength?: number;
      width?: number;
      height?: number;
      source?: "uploaded_image" | "existing_object" | "none";
    };
  }): Promise<StoredActionRunInputImage | null> {
    const objectKey = input.photo.objectKey?.trim();
    if (!objectKey) {
      return null;
    }

    if (input.photo.source === "existing_object" && input.photo.objectKey) {
      return {
        objectKey,
        contentType: input.photo.contentType ?? "application/octet-stream",
        byteLength: input.photo.byteLength ?? 0,
        source: "existing_object",
        ...(input.photo.width ? { width: input.photo.width } : {}),
        ...(input.photo.height ? { height: input.photo.height } : {}),
      };
    }

    if (!input.photo.dataUrl) {
      return null;
    }

    const parsed = parseDataUrl(input.photo.dataUrl);
    if (!parsed) {
      return null;
    }

    const bucketName = getConfig().s3.actionImageBucketName.trim();
    if (!bucketName) {
      return null;
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: Buffer.from(parsed.bytes),
        ContentType: parsed.contentType,
        CacheControl: "private, max-age=31536000, immutable",
        ContentDisposition: input.photo.fileName
          ? `inline; filename="${sanitizeFileName(input.photo.fileName)}"`
          : "inline",
      }),
    );

    logInfo("action_run.input_image.stored", {
      actionRunId: input.actionRunId,
      objectKey,
      contentType: parsed.contentType,
      byteLength: parsed.bytes.length,
    });

    return {
      objectKey,
      contentType: parsed.contentType,
      byteLength: parsed.bytes.length,
      source: "uploaded_image",
      ...(input.photo.width ? { width: input.photo.width } : {}),
      ...(input.photo.height ? { height: input.photo.height } : {}),
    };
  }

  async fetchActionRunInputImage(input: {
    objectKey: string;
  }): Promise<ResolvedActionRunInputImage | null> {
    const bucketName = getConfig().s3.actionImageBucketName.trim();
    if (!bucketName) {
      return null;
    }

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: input.objectKey,
      }),
    );

    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      return null;
    }

    const contentType = response.ContentType ?? "application/octet-stream";
    return {
      objectKey: input.objectKey,
      contentType,
      byteLength: bytes.length,
      source: "existing_object",
      bytes,
    };
  }
}

function parseDataUrl(
  dataUrl: string,
): { contentType: string; bytes: Uint8Array } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  const contentType = match[1].trim().toLowerCase();
  const base64 = match[2].trim();
  if (!contentType.startsWith("image/")) {
    return null;
  }

  return {
    contentType,
    bytes: Uint8Array.from(Buffer.from(base64, "base64")),
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/["\\]/g, "_");
}
