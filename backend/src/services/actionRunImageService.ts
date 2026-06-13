import { PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { getS3Client } from "../aws/s3";
import { getConfig } from "../config";
import { logInfo, logWarn } from "../logging";
import { buildActionRunImageUrl } from "./actionRunImageUrlService";
import type { ActionRunRequest, ActionRunResult } from "../types/actionRun";

export type GeneratedActionRunImage = {
  imageUrl: string;
  objectKey: string;
  contentType: "image/svg+xml";
};

export class ActionRunImageService {
  constructor(
    private readonly s3Client = getS3Client(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  async generateActionRunPoster(input: {
    actionRunId: string;
    request: ActionRunRequest;
    result: ActionRunResult;
  }): Promise<GeneratedActionRunImage | null> {
    if (getConfig().demoMode) {
      return buildFallbackGeneratedImage(input);
    }

    const bucketName = getConfig().s3.actionImageBucketName.trim();
    if (!bucketName) {
      logWarn("action_run.image_generation.skipped", {
        actionRunId: input.actionRunId,
        reason: "missing_bucket_name",
      });
      return buildFallbackGeneratedImage(input);
    }

    const objectKey = buildActionRunImageObjectKey(input.actionRunId);
    const svg = renderActionRunPosterSvg({
      request: input.request,
      result: input.result,
      actionRunId: input.actionRunId,
      generatedId: this.idFactory(),
    });

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: objectKey,
          Body: svg,
          ContentType: "image/svg+xml",
          CacheControl: "public, max-age=31536000, immutable",
          ContentDisposition: `inline; filename="poster-${input.actionRunId}.svg"`,
        }),
      );
    } catch (error) {
      logWarn("action_run.image_generation.fallback", {
        actionRunId: input.actionRunId,
        reason: "s3_upload_failed",
        errorName: error instanceof Error ? error.name : undefined,
      });
      return buildFallbackGeneratedImage(input);
    }

    const imageUrl = buildActionRunImageUrl({ actionRunId: input.actionRunId });
    if (!imageUrl) {
      throw new Error("Unable to build action run image URL.");
    }

    logInfo("action_run.image_generation.completed", {
      actionRunId: input.actionRunId,
      objectKey,
    });

    return {
      imageUrl,
      objectKey,
      contentType: "image/svg+xml",
    };
  }
}

function buildActionRunImageObjectKey(actionRunId: string): string {
  const prefix = normalizeObjectKeyPrefix(
    getConfig().s3.actionImageObjectKeyPrefix,
  );
  return `${prefix}/${actionRunId}/poster.svg`;
}

function normalizeObjectKeyPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || "action-runs";
}

function renderActionRunPosterSvg(input: {
  actionRunId: string;
  generatedId: string;
  request: ActionRunRequest;
  result: ActionRunResult;
}): string {
  const title = escapeXml(input.request.eventName);
  const postType = escapeXml(input.request.postType);
  const summary = escapeXml(input.result.summary);
  const imageCaption = escapeXml(input.result.imageCaption ?? "");
  const currentSituation = escapeXml(input.request.currentSituation);
  const hashtags = input.result.hashtags.slice(0, 4).map(escapeXml);
  const keySignals = input.result.evidence.slice(0, 2).map(escapeXml);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
  <title id="title">${title} ${postType}</title>
  <desc id="desc">AI PR Action poster for ${title}. Generated id ${escapeXml(input.generatedId)}.</desc>
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#f7fbff"/>
      <stop offset="58%" stop-color="#d9ecfb"/>
      <stop offset="100%" stop-color="#0a2e4a"/>
    </linearGradient>
    <linearGradient id="card" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.98"/>
      <stop offset="100%" stop-color="#f5f9fc" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="140" cy="120" r="96" fill="#ffffff" fill-opacity="0.18"/>
  <circle cx="1028" cy="126" r="128" fill="#ffffff" fill-opacity="0.10"/>
  <circle cx="1036" cy="514" r="180" fill="#08304f" fill-opacity="0.20"/>
  <rect x="54" y="54" width="1092" height="522" rx="36" fill="url(#card)"/>
  <rect x="84" y="84" width="154" height="38" rx="19" fill="#d9ecfb"/>
  <text x="106" y="109" fill="#0b3f66" font-size="16" font-weight="800" font-family="Aptos, Segoe UI, sans-serif" letter-spacing="1.4">AI PR ACTION</text>

  <text x="84" y="180" fill="#0a2941" font-size="50" font-weight="800" font-family="Aptos, Segoe UI, sans-serif">${title}</text>
  <text x="84" y="232" fill="#0d4167" font-size="25" font-weight="700" font-family="Aptos, Segoe UI, sans-serif">${postType}</text>
  <text x="84" y="280" fill="#4b5f72" font-size="22" font-weight="500" font-family="Aptos, Segoe UI, sans-serif">${truncateText(summary, 72)}</text>
  <text x="84" y="325" fill="#4b5f72" font-size="18" font-weight="500" font-family="Aptos, Segoe UI, sans-serif">${truncateText(imageCaption || currentSituation, 86)}</text>

  <rect x="84" y="360" width="1032" height="2" fill="#c9dff1"/>
  <text x="84" y="402" fill="#0a2941" font-size="18" font-weight="800" font-family="Aptos, Segoe UI, sans-serif">Key signals</text>
  ${renderSignalLines(keySignals)}

  <text x="84" y="494" fill="#0a2941" font-size="18" font-weight="800" font-family="Aptos, Segoe UI, sans-serif">Context</text>
  <text x="84" y="528" fill="#4b5f72" font-size="16" font-weight="500" font-family="Aptos, Segoe UI, sans-serif">${truncateText(currentSituation, 96)}</text>

  <g transform="translate(740 404)">
    ${renderChip(0, 0, postType)}
    ${renderChip(0, 48, hashtags[0] ?? "#AIPR")}
    ${renderChip(164, 48, hashtags[1] ?? "#Tableau")}
    ${renderChip(164, 0, hashtags[2] ?? "#TechPlay")}
  </g>

  <text x="84" y="576" fill="#6d7d8d" font-size="12" font-family="Aptos, Segoe UI, sans-serif">Generated for Slack image posting. Request ${escapeXml(input.actionRunId)}</text>
</svg>`;
}

function renderSignalLines(lines: string[]): string {
  return lines
    .slice(0, 2)
    .map((line, index) => {
      const y = 435 + index * 28;
      return `<text x="84" y="${y}" fill="#123049" font-size="17" font-weight="600" font-family="Aptos, Segoe UI, sans-serif">- ${truncateText(line, 72)}</text>`;
    })
    .join("\n  ");
}

function renderChip(x: number, y: number, text: string): string {
  const width = Math.min(150 + text.length * 5, 240);
  return `<g transform="translate(${x} ${y})">
    <rect width="${width}" height="32" rx="16" fill="#0d4167" fill-opacity="0.10" stroke="#0d4167" stroke-opacity="0.18"/>
    <text x="16" y="21" fill="#0d4167" font-size="14" font-weight="700" font-family="Aptos, Segoe UI, sans-serif">${escapeXml(truncateText(text, 28))}</text>
  </g>`;
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function buildFallbackGeneratedImage(input: {
  actionRunId: string;
  request: ActionRunRequest;
  result: ActionRunResult;
}): GeneratedActionRunImage {
  const svg = renderActionRunPosterSvg({
    ...input,
    generatedId: `demo-${input.actionRunId}`,
  });
  return {
    imageUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    objectKey: `demo/${input.actionRunId}/poster.svg`,
    contentType: "image/svg+xml",
  };
}
