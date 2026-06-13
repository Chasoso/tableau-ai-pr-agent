import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails } from "../logging";
import type { ActionRunRequest, ActionRunResult } from "../types/actionRun";

export type SlackWebhookPostResult = {
  sent: boolean;
  skipped: boolean;
  statusCode?: number;
  error?: string;
};

export class SlackWebhookService {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}

  async postActionRun(input: {
    request: ActionRunRequest;
    result: ActionRunResult;
  }): Promise<SlackWebhookPostResult> {
    if (getConfig().demoMode) {
      logWarn("slack.webhook.skipped", {
        reason: "demo_mode",
        eventName: input.request.eventName,
      });
      return { sent: false, skipped: true };
    }

    const webhookUrl = getConfig().slack.incomingWebhookUrl.trim();
    if (!webhookUrl) {
      logWarn("slack.webhook.skipped", {
        reason: "missing_webhook_url",
        eventName: input.request.eventName,
      });
      return { sent: false, skipped: true };
    }

    const payload = buildSlackPayload(input);
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
}) {
  const evidenceLines = input.result.evidence.slice(0, 4);
  const checkLines = input.result.checks.slice(0, 4);
  const analysisSectionLines = (input.result.analysisSections ?? [])
    .slice(0, 4)
    .map(
      (section) =>
        `• ${section.title}: ${section.summary} ${
          section.rows[0]
            ? `(${section.rows[0].label}${section.rows[0].value === null ? "" : `: ${section.rows[0].value}`})`
            : ""
        }`,
    );

  return {
    text: `${input.request.eventName} ${input.request.postType} draft`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${input.request.postType} draft for ${input.request.eventName}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Draft post*\n${input.result.suggestedSlackPostText}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Summary*\n${input.result.summary}`,
        },
      },
      ...(input.result.safetyReview
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: [
                  "*Human review*",
                  `Status: ${input.result.safetyReview.status}`,
                  ...input.result.safetyReview.checklist.map(
                    (line) => `- ${line}`,
                  ),
                  ...input.result.safetyReview.notes
                    .slice(0, 4)
                    .map((line) => `- ${line}`),
                ].join("\n"),
              },
            },
          ]
        : []),
      ...(input.result.imageUrl
        ? input.result.imageUrl.startsWith("http")
          ? [
              {
                type: "image",
                image_url: input.result.imageUrl,
                alt_text: `${input.request.eventName} poster image`,
              },
            ]
          : []
        : []),
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Evidence*\n${evidenceLines.map((line) => `• ${line}`).join("\n")}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Checks*\n${checkLines.map((line) => `• ${line}`).join("\n")}`,
        },
      },
      ...(analysisSectionLines.length
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Tableau signals*\n${analysisSectionLines.join("\n")}`,
              },
            },
          ]
        : []),
    ],
  };
}
