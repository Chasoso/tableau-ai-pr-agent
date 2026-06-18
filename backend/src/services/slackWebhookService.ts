import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails } from "../logging";
import type { ActionRunRequest, ActionRunResult } from "../types/actionRun";

type SlackBlock =
  | {
      type: "section";
      text: {
        type: "mrkdwn";
        text: string;
      };
    }
  | {
      type: "image";
      image_url: string;
      alt_text: string;
    };

export type SlackPostPayload = {
  text: string;
  blocks?: SlackBlock[];
};

export type ReviewMetadata = {
  summary?: unknown;
  evidence?: unknown;
  checks?: unknown;
  tableauSignals?: unknown;
  warnings?: string[];
};

export type SlackWebhookPostResult = {
  sent: boolean;
  skipped: boolean;
  statusCode?: number;
  error?: string;
};

const forbiddenSlackTextMarkers = [
  "Draft post",
  "Summary",
  "Human review",
  "Evidence",
  "Checks",
  "Tableau signals",
  "Missing fields",
  "Tableau warning",
  "query_tool_not_called",
];

export class SlackWebhookService {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}

  async postActionRun(input: {
    request: ActionRunRequest;
    result: ActionRunResult;
    runId?: string;
    selectedSuggestionText?: string;
    editedText?: string;
  }): Promise<SlackWebhookPostResult> {
    if (getConfig().demoMode) {
      logWarn("slack.webhook.skipped", {
        ...(input.runId ? { runId: input.runId } : {}),
        reason: "demo_mode",
        eventName: input.request.eventName,
      });
      return { sent: false, skipped: true };
    }

    const webhookUrl = getConfig().slack.incomingWebhookUrl.trim();
    if (!webhookUrl) {
      logWarn("slack.webhook.skipped", {
        ...(input.runId ? { runId: input.runId } : {}),
        reason: "missing_webhook_url",
        eventName: input.request.eventName,
      });
      return { sent: false, skipped: true };
    }

    logInfo("slackPayloadBuildStarted", {
      ...(input.runId ? { runId: input.runId } : {}),
      eventName: input.request.eventName,
      selectedSuggestionPresent: Boolean(input.selectedSuggestionText?.trim()),
      editedTextPresent: Boolean(input.editedText?.trim()),
      attachedImagePresent: Boolean(
        input.result.attachedImage?.url ?? input.result.imageUrl,
      ),
    });

    const payload = buildSlackPayload(input);
    const payloadText = payload.text;
    const payloadString = JSON.stringify(payload);
    const containsReviewMarkers = forbiddenSlackTextMarkers.some(
      (marker) =>
        payloadText.includes(marker) || payloadString.includes(marker),
    );

    logInfo("slackPayloadBuilt", {
      ...(input.runId ? { runId: input.runId } : {}),
      eventName: input.request.eventName,
      textLength: payloadText.length,
      hasBlocks: Boolean(payload.blocks?.length),
      blockCount: payload.blocks?.length ?? 0,
      containsReviewSections: containsReviewMarkers,
      containsEvidenceSection: payloadString.includes("*Evidence*"),
      containsChecksSection: payloadString.includes("*Checks*"),
      containsTableauSignals: payloadString.includes("*Tableau signals*"),
      containsDebugMetadata:
        payloadString.includes("Missing fields") ||
        payloadString.includes("query_tool_not_called"),
    });

    if (containsReviewMarkers) {
      logWarn("slackPayloadContainsReviewMarker", {
        ...(input.runId ? { runId: input.runId } : {}),
        eventName: input.request.eventName,
        markers: forbiddenSlackTextMarkers.filter(
          (marker) =>
            payloadText.includes(marker) || payloadString.includes(marker),
        ),
      });
    }

    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = `Slack webhook returned ${response.status}`;
        logWarn("slack.webhook.failed", {
          ...(input.runId ? { runId: input.runId } : {}),
          eventName: input.request.eventName,
          statusCode: response.status,
        });
        return {
          sent: false,
          skipped: false,
          statusCode: response.status,
          error,
        };
      }

      logInfo("slack.webhook.sent", {
        ...(input.runId ? { runId: input.runId } : {}),
        eventName: input.request.eventName,
        sectionCount: input.result.analysisSections?.length ?? 0,
      });
      return {
        sent: true,
        skipped: false,
        statusCode: response.status,
      };
    } catch (error) {
      const details = safeErrorDetails(error);
      logWarn("slack.webhook.failed", {
        ...(input.runId ? { runId: input.runId } : {}),
        eventName: input.request.eventName,
        ...details,
      });
      return {
        sent: false,
        skipped: false,
        error: error instanceof Error ? error.message : "Slack webhook failed.",
      };
    }
  }
}

function buildSlackPayload(input: {
  request: ActionRunRequest;
  result: ActionRunResult;
  selectedSuggestionText?: string;
  editedText?: string;
}): SlackPostPayload {
  const slackPostText = resolveSlackPostText(input);
  const imageUrl = input.result.attachedImage?.url ?? input.result.imageUrl;
  const blocks: SlackBlock[] = [];

  if (slackPostText) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: slackPostText,
      },
    });
  }

  if (imageUrl && imageUrl.startsWith("http")) {
    blocks.push({
      type: "image",
      image_url: imageUrl,
      alt_text: shortAltText(input.request.eventName, input.request.postType),
    });
  }

  return {
    text: slackPostText,
    ...(blocks.length ? { blocks } : {}),
  };
}

function resolveSlackPostText(input: {
  result: ActionRunResult;
  selectedSuggestionText?: string;
  editedText?: string;
}): string {
  const candidate =
    input.editedText?.trim() ||
    input.selectedSuggestionText?.trim() ||
    input.result.generatedPostSuggestions?.[0]?.text?.trim() ||
    input.result.suggestedSlackPostText.trim() ||
    "";

  return sanitizeSlackPostText(candidate);
}

function sanitizeSlackPostText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !forbiddenSlackTextMarkers.includes(line.trim()));

  return lines.join("\n").trim();
}

function shortAltText(eventName: string, postType: string): string {
  const base = `${eventName} ${postType}`.trim();
  return base.length > 60 ? `${base.slice(0, 57)}...` : base;
}
