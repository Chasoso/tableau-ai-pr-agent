import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
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
    if (input.photo.source === "existing_object" && input.photo.objectKey) {
      return {
        objectKey: input.photo.objectKey,
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

    const objectKey = buildInputImageObjectKey({
      actionRunId: input.actionRunId,
      contentType: parsed.contentType,
      fileName: input.photo.fileName,
    });

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

function buildInputImageObjectKey(input: {
  actionRunId: string;
  contentType: string;
  fileName?: string;
}): string {
  const prefix = normalizeObjectKeyPrefix(
    getConfig().s3.actionImageObjectKeyPrefix,
  );
  const extension = guessExtension(input.contentType, input.fileName);
  const hash = createHash("sha256")
    .update(`${input.actionRunId}:${input.fileName ?? ""}:${input.contentType}`)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}/${input.actionRunId}/input/${hash}${extension}`;
}

function guessExtension(contentType: string, fileName?: string): string {
  const lower = contentType.toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") {
    return ".jpg";
  }
  if (lower === "image/png") {
    return ".png";
  }
  if (lower === "image/webp") {
    return ".webp";
  }
  if (lower === "image/gif") {
    return ".gif";
  }

  const match = fileName?.match(/\.(jpe?g|png|webp|gif)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".img";
}

function normalizeObjectKeyPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || "action-runs";
}

function sanitizeFileName(value: string): string {
  return value.replace(/["\\]/g, "_");
}
