import { getConfig } from "../config";

export function buildActionRunImageUrl(input: {
  actionRunId: string;
}): string | undefined {
  const config = getConfig().s3;
  const baseUrl = config.actionImagePublicBaseUrl.trim();
  if (!baseUrl) {
    return undefined;
  }

  const objectKeyPrefix = normalizeObjectKeyPrefix(
    config.actionImageObjectKeyPrefix,
  );
  const objectKey = `${objectKeyPrefix}/${input.actionRunId}/poster.svg`;
  return buildPublicImageUrl(objectKey, baseUrl);
}

export function buildActionRunPublicImageUrl(
  objectKey: string,
): string | undefined {
  const baseUrl = getConfig().s3.actionImagePublicBaseUrl.trim();
  if (!baseUrl) {
    return undefined;
  }

  return buildPublicImageUrl(objectKey, baseUrl);
}

function normalizeObjectKeyPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || "action-runs";
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/g, "");
}

function buildPublicImageUrl(objectKey: string, baseUrl: string): string {
  const trimmedObjectKey = objectKey.trim().replace(/^\/+/, "");
  return `${trimTrailingSlashes(baseUrl)}/${trimmedObjectKey}`;
}
