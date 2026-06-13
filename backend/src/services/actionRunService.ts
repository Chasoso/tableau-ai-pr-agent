import { InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";
import { getLambdaClient } from "../aws/lambda";
import { getConfig } from "../config";
import {
  logError,
  logInfo,
  logWarn,
  safeErrorDetails,
  safeHash,
} from "../logging";
import { ActionRunAnalysisService } from "./actionRunAnalysisService";
import { ActionRunImageService } from "./actionRunImageService";
import { buildActionRunImageUrl } from "./actionRunImageUrlService";
import { ActionRunRepository } from "../repositories/actionRunRepository";
import { SlackWebhookService } from "./slackWebhookService";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunApprovalRequest,
  ActionRunGetResponse,
  ActionRunCreateResponse,
  ActionRunRecord,
  ActionRunRequest,
  ActionRunResult,
} from "../types/actionRun";
import type { SlackWebhookPostResult } from "./slackWebhookService";

export type ActionRunApprovalResponse = ActionRunGetResponse & {
  slackWebhook: SlackWebhookPostResult;
};

const repository = new ActionRunRepository();
const analysisService = new ActionRunAnalysisService();
const imageService = new ActionRunImageService();
const slackWebhookService = new SlackWebhookService();

export class ActionRunService {
  async createActionRun(input: {
    request: ActionRunRequest;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
    requestId?: string;
  }): Promise<ActionRunCreateResponse> {
    const config = getConfig();
    const ownerContext = resolveOwnerContext({
      authenticatedUser: input.authenticatedUser,
      headers: input.headers,
    });
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const runId = jobId;

    const record: ActionRunRecord = {
      jobId,
      jobType: "action_run",
      ownerKey: ownerContext.ownerKey,
      ownerType: input.authenticatedUser ? "authenticated" : "anonymous",
      ...(input.authenticatedUser?.userId
        ? { ownerUserId: input.authenticatedUser.userId }
        : {}),
      status: "queued",
      stage: "queued",
      progressMessages: [
        {
          at: createdAt,
          stage: "queued",
          message: "Action run request accepted.",
        },
      ],
      request: input.request,
      createdAt,
      updatedAt: createdAt,
      expiresAt:
        Math.floor(Date.now() / 1000) +
        Math.max(60, config.actionRun.ttlSeconds),
    };

    await repository.create(record);
    logInfo("action_run.created", {
      runId,
      actionRunId: jobId,
      requestId: input.requestId,
      authenticated: Boolean(input.authenticatedUser),
      ownerKeyHash: safeHash(ownerContext.ownerKey),
      postType: input.request.postType,
      eventName: input.request.eventName,
    });

    if (!config.actionRun.workerFunctionName) {
      logWarn("action_run.dispatch_inline", {
        runId,
        actionRunId: jobId,
        requestId: input.requestId,
      });
      void this.processActionRun(
        {
          actionRunId: jobId,
        },
        input.authenticatedUser,
      ).catch((error) => {
        logError("action_run.inline_worker_failed", {
          runId,
          actionRunId: jobId,
          ...safeErrorDetails(error),
        });
      });
    } else {
      try {
        await getLambdaClient().send(
          new InvokeCommand({
            FunctionName: config.actionRun.workerFunctionName,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ jobId })),
          }),
        );
      } catch (error) {
        logError("action_run.dispatch_failed", {
          runId,
          actionRunId: jobId,
          ...safeErrorDetails(error),
        });
        await repository.markFailed({
          actionRunId: jobId,
          error: {
            code: "dispatch_failed",
            message: "Worker Lambda invocation failed.",
            details: safeErrorDetails(error),
          },
        });
        throw new Error("Failed to start action run.");
      }
    }

    return {
      actionRunId: jobId,
      jobType: "action_run",
      status: "queued",
      stage: "queued",
      pollUrl: `/action-runs/${jobId}`,
      retryAfterMs: 1500,
      ...(ownerContext.ownerToken
        ? { ownerToken: ownerContext.ownerToken }
        : {}),
    };
  }

  async getActionRun(input: {
    actionRunId: string;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
  }): Promise<ActionRunGetResponse> {
    const record = await repository.get(input.actionRunId);
    if (!record) {
      throw new Error("Action run not found.");
    }

    this.assertOwner(record, input.authenticatedUser, input.headers);
    return repository.toPublicView(record);
  }

  async approveActionRun(input: {
    actionRunId: string;
    request: ActionRunApprovalRequest;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
    requestId?: string;
  }): Promise<ActionRunApprovalResponse> {
    const record = await repository.get(input.actionRunId);
    if (!record) {
      throw new Error("Action run not found.");
    }

    this.assertOwner(record, input.authenticatedUser, input.headers);

    if (!record.result) {
      throw new Error("Action run result is not ready for approval.");
    }

    if (record.result.safetyReview?.status === "sent_to_slack") {
      throw new Error("Action run has already been sent to Slack.");
    }

    if (!input.request.approved) {
      throw new Error("Action run approval is required before Slack posting.");
    }

    const nowIso = new Date().toISOString();
    const reviewerNote = input.request.reviewerNote?.trim();
    const safetyReview = record.result.safetyReview ?? {
      status: "pending_manual_review" as const,
      required: true as const,
      checklist: record.result.checks,
      notes: [],
    };
    const approvedSafetyReview: NonNullable<
      ActionRunRecord["result"]
    >["safetyReview"] = {
      ...safetyReview,
      status: "approved",
      reviewedAt: nowIso,
      ...(reviewerNote ? { reviewerNote } : {}),
    };
    const approvedResult: ActionRunResult = {
      ...record.result,
      safetyReview: approvedSafetyReview,
    };

    await repository.updateResult({
      actionRunId: input.actionRunId,
      result: approvedResult,
    });

    const slackWebhook = await slackWebhookService.postActionRun({
      runId: input.actionRunId,
      request: record.request,
      result: approvedResult,
    });

    const finalSafetyReview: NonNullable<
      ActionRunRecord["result"]
    >["safetyReview"] = {
      ...approvedSafetyReview,
      status: slackWebhook.sent ? "sent_to_slack" : "approved",
      ...(slackWebhook.sent ? { sentAt: nowIso } : {}),
    };
    const finalResult: ActionRunResult = {
      ...approvedResult,
      safetyReview: finalSafetyReview,
    };

    const updatedRecord = await repository.updateResult({
      actionRunId: input.actionRunId,
      result: finalResult,
    });

    logInfo("action_run.approved", {
      runId: input.actionRunId,
      actionRunId: input.actionRunId,
      requestId: input.requestId,
      slackSent: slackWebhook.sent,
      slackSkipped: slackWebhook.skipped,
    });

    return {
      ...(updatedRecord
        ? await repository.toPublicView(updatedRecord)
        : await repository.toPublicView({ ...record, result: finalResult })),
      slackWebhook,
    };
  }

  async processActionRun(
    input: {
      actionRunId: string;
      getRemainingTimeInMillis?: () => number;
    },
    authenticatedUser?: AuthenticatedUser,
  ): Promise<void> {
    void input.getRemainingTimeInMillis;
    const nowIso = new Date().toISOString();
    const leaseExpiresAtIso = new Date(
      Date.now() + Math.max(30, getConfig().actionRun.leaseSeconds) * 1000,
    ).toISOString();
    const claimed = await repository.claim(input.actionRunId, {
      workerId: `worker-${randomUUID()}`,
      nowIso,
      leaseExpiresAtIso,
    });

    if (!claimed) {
      logWarn("action_run.claim_skipped", {
        runId: input.actionRunId,
        actionRunId: input.actionRunId,
      });
      return;
    }

    logInfo("action_run.claimed", {
      runId: input.actionRunId,
      actionRunId: input.actionRunId,
      ownerType: claimed.ownerType,
      attemptCount: claimed.attemptCount ?? 1,
      stage: claimed.stage,
      status: claimed.status,
    });

    try {
      await this.reportProgress(input.actionRunId, {
        stage: "loading_dashboard_context",
        message: "Loading Tableau dashboard context...",
      });
      await this.reportProgress(input.actionRunId, {
        stage: "planning",
        message: "Planning fixed analysis...",
      });
      await this.reportProgress(input.actionRunId, {
        stage: "running_mcp_tools",
        message: "Running Tableau MCP fixed analysis...",
      });

      const response = await analysisService.analyzeActionRun({
        request: claimed.request,
        authenticatedUser,
      });
      const generatedImage = await imageService.generateActionRunPoster({
        actionRunId: input.actionRunId,
        runId: input.actionRunId,
        request: claimed.request,
        result: response,
      });
      const imageUrl =
        generatedImage?.imageUrl ??
        buildActionRunImageUrl({
          actionRunId: input.actionRunId,
        });
      const completedResult = {
        ...response,
        ...(imageUrl ? { imageUrl } : {}),
      };

      await repository.markCompleted({
        actionRunId: input.actionRunId,
        result: completedResult,
      });

      await this.reportProgress(input.actionRunId, {
        stage: "completed",
        message:
          "Draft analysis completed. Human approval is required before Slack posting.",
        status: "completed",
        debug: {
          summaryLength: completedResult.summary.length,
          sectionCount: completedResult.analysisSections?.length ?? 0,
          hasImageUrl: Boolean(imageUrl),
          safetyReviewStatus:
            completedResult.safetyReview?.status ?? "pending_manual_review",
          imageGeneration: generatedImage
            ? {
                contentType: generatedImage.contentType,
                objectKey: generatedImage.objectKey,
              }
            : { skipped: true },
        },
      });
      logInfo("action_run.completed", {
        runId: input.actionRunId,
        actionRunId: input.actionRunId,
        sectionCount: completedResult.analysisSections?.length ?? 0,
        hasImageUrl: Boolean(imageUrl),
        humanApprovalRequired: true,
      });
    } catch (error) {
      logError("action_run.failed", {
        runId: input.actionRunId,
        actionRunId: input.actionRunId,
        ...safeErrorDetails(error),
      });
      await repository.markFailed({
        actionRunId: input.actionRunId,
        error: {
          code:
            error instanceof Error && error.name ? error.name : "worker_failed",
          message:
            error instanceof Error
              ? error.message
              : "Action run processing failed.",
          details: safeErrorDetails(error),
        },
      });
      await this.reportProgress(input.actionRunId, {
        stage: "failed",
        message: "Fixed analysis failed.",
        status: "failed",
        debug: safeErrorDetails(error),
      });
    }
  }

  private async reportProgress(
    actionRunId: string,
    update: {
      stage:
        | "queued"
        | "loading_history"
        | "loading_dashboard_context"
        | "planning"
        | "running_mcp_tools"
        | "generating_answer"
        | "finalizing"
        | "completed"
        | "failed";
      message: string;
      toolName?: string;
      debug?: Record<string, unknown>;
      status?: ActionRunRecord["status"];
    },
  ): Promise<void> {
    await repository.updateProgress(actionRunId, {
      ...update,
      maxMessages: getConfig().actionRun.progressMessageLimit,
    });
  }

  private assertOwner(
    record: ActionRunRecord,
    authenticatedUser?: AuthenticatedUser,
    headers?: Record<string, string | undefined>,
  ): void {
    const expectedOwnerKey = resolveOwnerContext({
      authenticatedUser,
      headers,
    }).ownerKey;

    if (record.ownerKey !== expectedOwnerKey) {
      throw new Error("You do not have access to this action run.");
    }
  }
}

function resolveOwnerContext(input: {
  authenticatedUser?: AuthenticatedUser;
  headers?: Record<string, string | undefined>;
}): { ownerKey: string; ownerToken?: string } {
  if (input.authenticatedUser?.userId) {
    return { ownerKey: `user:${input.authenticatedUser.userId}` };
  }

  const config = getConfig();
  const ownerToken =
    getHeader(input.headers, config.actionRun.ownerTokenHeaderName) ||
    getHeader(input.headers, config.chatJob.ownerTokenHeaderName) ||
    randomUUID();
  return {
    ownerKey: `anon:${ownerToken}`,
    ownerToken,
  };
}

function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1]?.trim() || undefined;
}
