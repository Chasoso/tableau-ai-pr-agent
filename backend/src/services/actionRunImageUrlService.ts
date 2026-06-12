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
  const objectKey = `${objectKeyPrefix}/${input.actionRunId}/poster.png`;
  return `${trimTrailingSlashes(baseUrl)}/${objectKey}`;
}

function normalizeObjectKeyPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || "action-runs";
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/g, "");
}
