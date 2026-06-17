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
import { ActionRunInputImageService } from "./actionRunInputImageService";
import { BlueskyPostService } from "./blueskyPostService";
import { runTableauConnectivityDiagnosticsWithAuthContext } from "./tableauConnectivityDiagnostics";
import { ActionRunRepository } from "../repositories/actionRunRepository";
import { SlackWebhookService } from "./slackWebhookService";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunBlueskyPostRequest,
  ActionRunApprovalRequest,
  ActionRunGetResponse,
  ActionRunCreateResponse,
  ActionRunInputImageUploadRequest,
  ActionRunInputImageUploadResponse,
  ActionRunRecord,
  ActionRunRequest,
  ActionRunResult,
} from "../types/actionRun";
import type { ChatJobAuthSnapshot } from "../types/chatJob";
import type { BlueskyPostResult } from "./blueskyPostService";
import type { SlackWebhookPostResult } from "./slackWebhookService";

export type ActionRunApprovalResponse = ActionRunGetResponse & {
  slackWebhook: SlackWebhookPostResult;
};

export type ActionRunBlueskyPostResponse = ActionRunGetResponse & {
  blueskyPost: BlueskyPostResult;
};

const repository = new ActionRunRepository();
const analysisService = new ActionRunAnalysisService();
const inputImageService = new ActionRunInputImageService();
const blueskyPostService = new BlueskyPostService();
const slackWebhookService = new SlackWebhookService();

export class ActionRunService {
  async uploadActionRunInputImage(input: {
    request: ActionRunInputImageUploadRequest;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
    requestId?: string;
  }): Promise<ActionRunInputImageUploadResponse> {
    void input.authenticatedUser;
    void input.headers;
    const uploadId = randomUUID();
    const objectKey = buildInputImageObjectKey(
      uploadId,
      input.request.fileName,
    );
    const stored = await inputImageService.storeActionRunInputImage({
      actionRunId: uploadId,
      photo: {
        fileName: input.request.fileName,
        dataUrl: input.request.dataUrl,
        objectKey,
        contentType: input.request.contentType,
        byteLength: input.request.byteLength,
        width: input.request.width,
        height: input.request.height,
        source: "uploaded_image",
      },
    });

    if (!stored) {
      throw new Error("Failed to store input image.");
    }

    logInfo("action_run.input_image_upload.started", {
      requestId: input.requestId,
      objectKey,
      contentType: stored.contentType,
      byteLength: stored.byteLength,
      width: stored.width,
      height: stored.height,
    });

    return {
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteLength: stored.byteLength,
      width: stored.width,
      height: stored.height,
      source: "uploaded_image",
    };
  }

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
    const authContextSnapshot = buildAuthSnapshot(input.authenticatedUser);
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const runId = jobId;
    const imageMetadata = await storeInputImage(jobId, input.request);
    const requestWithImage = imageMetadata
      ? attachStoredImageMetadata(input.request, imageMetadata)
      : stripInputImageDataUrl(input.request);

    logInfo("action_run_input_received", {
      runId,
      actionRunId: jobId,
      requestId: input.requestId,
      postType: input.request.postType,
      eventName: input.request.eventName,
      hasInputImage: Boolean(requestWithImage.inputImage?.objectKey),
      inputImageSource: requestWithImage.inputImage?.source ?? "none",
      inputImageObjectKeyPresent: Boolean(
        requestWithImage.inputImage?.objectKey,
      ),
      inputImageContentType:
        requestWithImage.inputImage?.contentType ?? undefined,
      inputImageBytes: requestWithImage.inputImage?.bytes ?? undefined,
      inputImageWidth: requestWithImage.inputImage?.width ?? undefined,
      inputImageHeight: requestWithImage.inputImage?.height ?? undefined,
      imageUploadCompleted: Boolean(imageMetadata),
    });

    const record: ActionRunRecord = {
      jobId,
      jobType: "action_run",
      ownerKey: ownerContext.ownerKey,
      ownerType: input.authenticatedUser ? "authenticated" : "anonymous",
      ...(input.authenticatedUser?.userId
        ? { ownerUserId: input.authenticatedUser.userId }
        : {}),
      ...(authContextSnapshot ? { authContextSnapshot } : {}),
      status: "queued",
      stage: "queued",
      progressMessages: [
        {
          at: createdAt,
          stage: "queued",
          message: "Action run request accepted.",
        },
      ],
      request: requestWithImage,
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
      hasInputImage: Boolean(requestWithImage.inputImage?.objectKey),
      inputImageObjectKeyPresent: Boolean(
        requestWithImage.inputImage?.objectKey,
      ),
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
      ...(requestWithImage.inputImage?.objectKey
        ? {
            inputImageObjectKey: requestWithImage.inputImage.objectKey,
            inputImageContentType: requestWithImage.inputImage.contentType,
            inputImageBytes: requestWithImage.inputImage.bytes,
            inputImageWidth: requestWithImage.inputImage.width,
            inputImageHeight: requestWithImage.inputImage.height,
          }
        : {}),
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

    if (
      record.result.safetyReview?.status === "sent_to_slack" ||
      record.result.safetyReview?.status === "sent_to_bluesky"
    ) {
      throw new Error("Action run has already been finalized.");
    }

    if (!input.request.approved) {
      throw new Error(
        "Action run approval is required before finalizing the draft.",
      );
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

    const finalSafetyReview: NonNullable<
      ActionRunRecord["result"]
    >["safetyReview"] = {
      ...approvedSafetyReview,
    };
    const finalResult: ActionRunResult = {
      ...approvedResult,
      safetyReview: finalSafetyReview,
    };

    const updatedRecord = await repository.updateResult({
      actionRunId: input.actionRunId,
      result: finalResult,
    });

    const slackWebhookResult = await slackWebhookService.postActionRun({
      request: record.request,
      result: finalResult,
      runId: input.actionRunId,
      selectedSuggestionText: input.request.selectedSuggestionText,
    });

    logInfo("action_run.approved", {
      runId: input.actionRunId,
      actionRunId: input.actionRunId,
      requestId: input.requestId,
      slackSent: slackWebhookResult.sent,
      slackSkipped: slackWebhookResult.skipped,
    });

    return {
      ...(updatedRecord
        ? await repository.toPublicView(updatedRecord)
        : await repository.toPublicView({ ...record, result: finalResult })),
      slackWebhook: slackWebhookResult,
    };
  }

  async postActionRunToBluesky(input: {
    actionRunId: string;
    request: ActionRunBlueskyPostRequest;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
    requestId?: string;
  }): Promise<ActionRunBlueskyPostResponse> {
    const record = await repository.get(input.actionRunId);
    if (!record) {
      throw new Error("Action run not found.");
    }

    this.assertOwner(record, input.authenticatedUser, input.headers);

    if (!record.result) {
      throw new Error("Action run result is not ready for posting.");
    }

    if (record.result.safetyReview?.status === "sent_to_bluesky") {
      throw new Error("Action run has already been posted to Bluesky.");
    }

    if (
      !record.result.safetyReview ||
      record.result.safetyReview.status === "pending_manual_review"
    ) {
      throw new Error("Action run must be approved before posting to Bluesky.");
    }

    const selectedSuggestionText =
      input.request.selectedSuggestionText?.trim() ||
      record.result.generatedPostSuggestions?.[0]?.text?.trim() ||
      record.result.generatedPostSuggestion?.text?.trim() ||
      record.result.suggestedSlackPostText.trim();

    const blueskyPostResult = await blueskyPostService.postText({
      text: selectedSuggestionText,
      runId: input.actionRunId,
    });

    if (blueskyPostResult.sent) {
      const nowIso = new Date().toISOString();
      const safetyReview = record.result.safetyReview;
      const updatedResult: ActionRunResult = {
        ...record.result,
        safetyReview: safetyReview
          ? {
              ...safetyReview,
              status: "sent_to_bluesky" as const,
              sentAt: nowIso,
            }
          : safetyReview,
      };

      await repository.updateResult({
        actionRunId: input.actionRunId,
        result: updatedResult,
      });
    }

    const publicRecord = blueskyPostResult.sent
      ? {
          ...record,
          result: {
            ...record.result,
            safetyReview: record.result.safetyReview
              ? {
                  ...record.result.safetyReview,
                  status: "sent_to_bluesky" as const,
                  sentAt: new Date().toISOString(),
                }
              : record.result.safetyReview,
          },
        }
      : record;

    return {
      ...(await repository.toPublicView(publicRecord)),
      blueskyPost: blueskyPostResult,
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

    const effectiveAuthenticatedUser =
      authenticatedUser ?? buildAuthenticatedUserFromSnapshot(claimed);

    if (claimed.ownerType === "authenticated" && !effectiveAuthenticatedUser) {
      logWarn("action_run.auth_context_missing", {
        actionRunId: input.actionRunId,
        ownerUserId: claimed.ownerUserId,
        authSnapshotPresent: Boolean(claimed.authContextSnapshot),
      });
    }

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
        authenticatedUser: effectiveAuthenticatedUser,
      });
      if (!response.canGeneratePost) {
        const generationBlockers = response.generationBlockers ?? [];
        throw new Error(
          `Required analysis was not completed: ${generationBlockers.join(", ") || "unknown blockers"}`,
        );
      }
      const attachedImage =
        response.attachedImage ?? buildAttachedInputImage(claimed.request);
      const completedResult = {
        ...response,
        ...(attachedImage ? { attachedImage } : {}),
      };

      logInfo("actionRunResponseBuilt", {
        actionRunId: input.actionRunId,
        primaryOutputType:
          completedResult.primaryOutputType ?? "analysis_summary",
        hasGeneratedPostSuggestions:
          (completedResult.generatedPostSuggestions?.length ?? 0) > 0,
        generatedPostSuggestionCount:
          completedResult.generatedPostSuggestions?.length ?? 0,
        primaryOutputTextLength:
          completedResult.generatedPostSuggestions?.[0]?.text?.length ??
          completedResult.suggestedSlackPostText.length,
        hasPhotoAnalysisSections:
          (completedResult.analysisSections?.length ?? 0) > 0,
        hasAttachedInputImage: Boolean(attachedImage),
        attachedInputImageObjectKeyPresent: Boolean(attachedImage?.objectKey),
        hasPosterImage: false,
        posterGenerationSkipped: true,
      });

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
          hasImageUrl: false,
          safetyReviewStatus:
            completedResult.safetyReview?.status ?? "pending_manual_review",
          imageGeneration: { skipped: true },
        },
      });
      logInfo("action_run.completed", {
        runId: input.actionRunId,
        actionRunId: input.actionRunId,
        sectionCount: completedResult.analysisSections?.length ?? 0,
        hasImageUrl: false,
        hasAttachedInputImage: Boolean(attachedImage),
        humanApprovalRequired: true,
      });
    } catch (error) {
      const tableauDiagnostics = await buildTableauFailureDiagnostics(
        effectiveAuthenticatedUser,
      );
      const failureDetails = {
        ...safeErrorDetails(error),
        ...(tableauDiagnostics ? { tableauDiagnostics } : {}),
      };
      logError("action_run.failed", {
        runId: input.actionRunId,
        actionRunId: input.actionRunId,
        ...failureDetails,
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
          details: failureDetails,
        },
      });
      await this.reportProgress(input.actionRunId, {
        stage: "failed",
        message: "Fixed analysis failed.",
        status: "failed",
        debug: failureDetails,
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

async function storeInputImage(
  actionRunId: string,
  request: ActionRunRequest,
): Promise<{
  objectKey: string;
  contentType: string;
  byteLength: number;
  width?: number;
  height?: number;
} | null> {
  const legacyPhoto = request.clientContext?.photo;
  const inputImage = request.inputImage;
  const objectKey =
    inputImage?.objectKey?.trim() ?? legacyPhoto?.objectKey?.trim();
  if (!objectKey) {
    return null;
  }

  const dataUrl = legacyPhoto?.dataUrl;
  const contentType =
    inputImage?.contentType ??
    legacyPhoto?.contentType ??
    legacyPhoto?.mimeType ??
    undefined;
  const fileName = inputImage?.originalFileName ?? legacyPhoto?.fileName;
  const byteLength = inputImage?.bytes ?? legacyPhoto?.byteLength;
  const width = inputImage?.width ?? legacyPhoto?.width;
  const height = inputImage?.height ?? legacyPhoto?.height;
  const source =
    inputImage?.source === "camera" ||
    inputImage?.source === "library" ||
    inputImage?.source === "upload"
      ? "uploaded_image"
      : legacyPhoto?.source === "existing_object"
        ? "existing_object"
        : legacyPhoto?.source === "uploaded_image"
          ? "uploaded_image"
          : "uploaded_image";

  if (!dataUrl && source !== "existing_object") {
    return null;
  }

  const stored = await inputImageService.storeActionRunInputImage({
    actionRunId,
    photo: {
      fileName,
      dataUrl,
      objectKey,
      contentType,
      byteLength,
      width,
      height,
      source,
    },
  });

  if (!stored) {
    return null;
  }

  return stored;
}

function attachStoredImageMetadata(
  request: ActionRunRequest,
  imageMetadata: {
    objectKey: string;
    contentType: string;
    byteLength: number;
    width?: number;
    height?: number;
  },
): ActionRunRequest {
  return {
    ...request,
    inputImage: imageMetadata
      ? {
          source: request.inputImage?.source ?? "upload",
          objectKey: imageMetadata.objectKey,
          contentType: imageMetadata.contentType,
          bytes: imageMetadata.byteLength,
          width: imageMetadata.width,
          height: imageMetadata.height,
          originalFileName: request.inputImage?.originalFileName,
          fileId: request.inputImage?.fileId,
        }
      : request.inputImage,
    clientContext: request.clientContext
      ? {
          ...request.clientContext,
          photo: request.clientContext.photo
            ? {
                ...request.clientContext.photo,
                objectKey: imageMetadata.objectKey,
                contentType: imageMetadata.contentType,
                byteLength: imageMetadata.byteLength,
                width: imageMetadata.width,
                height: imageMetadata.height,
                source: "uploaded_image",
                dataUrl: undefined,
              }
            : request.clientContext.photo,
        }
      : request.clientContext,
  };
}

function stripInputImageDataUrl(request: ActionRunRequest): ActionRunRequest {
  const photo = request.clientContext?.photo;
  if (!photo?.dataUrl) {
    return request;
  }

  return {
    ...request,
    clientContext: request.clientContext
      ? {
          ...request.clientContext,
          photo: {
            ...photo,
            dataUrl: undefined,
          },
        }
      : request.clientContext,
  };
}

function buildAuthSnapshot(
  authenticatedUser?: AuthenticatedUser,
): ChatJobAuthSnapshot | undefined {
  if (!authenticatedUser?.userId) {
    return undefined;
  }

  return {
    userId: authenticatedUser.userId,
    ...(authenticatedUser.email ? { email: authenticatedUser.email } : {}),
    ...(authenticatedUser.tableauSubject || authenticatedUser.email
      ? {
          tableauSubject:
            authenticatedUser.tableauSubject ?? authenticatedUser.email,
        }
      : {}),
    ...(authenticatedUser.tokenUse
      ? { tokenUse: authenticatedUser.tokenUse }
      : {}),
  };
}

function buildAuthenticatedUserFromSnapshot(
  record: Pick<ActionRunRecord, "authContextSnapshot">,
): AuthenticatedUser | undefined {
  const snapshot = record.authContextSnapshot;
  if (!snapshot?.userId) {
    return undefined;
  }

  return {
    userId: snapshot.userId,
    ...(snapshot.email ? { email: snapshot.email } : {}),
    ...(snapshot.tableauSubject
      ? { tableauSubject: snapshot.tableauSubject }
      : {}),
    ...(snapshot.tokenUse ? { tokenUse: snapshot.tokenUse } : {}),
  };
}

async function buildTableauFailureDiagnostics(
  authenticatedUser?: AuthenticatedUser,
): Promise<
  | {
      enabled: true;
      config: {
        serverUrlConfigured: boolean;
        siteContentUrlConfigured: boolean;
        apiVersion: string;
        subjectConfigured: boolean;
        scopesConfigured: string[];
        connectedAppConfigured: {
          clientId: boolean;
          secretId: boolean;
          secretValue: boolean;
        };
      };
      reachability: {
        ok: boolean;
        status?: number;
        durationMs?: number;
        error?: Record<string, unknown>;
      };
      authentication: {
        ok: boolean;
        signedIn?: boolean;
        status?: number;
        userIdHash?: string;
        siteIdHash?: string;
        error?: Record<string, unknown>;
      };
    }
  | undefined
> {
  try {
    return await runTableauConnectivityDiagnosticsWithAuthContext({
      authenticatedUser,
    });
  } catch (error) {
    return {
      enabled: true,
      config: {
        serverUrlConfigured: Boolean(getConfig().tableau.serverUrl.trim()),
        siteContentUrlConfigured: Boolean(
          getConfig().tableau.siteContentUrl.trim(),
        ),
        apiVersion: getConfig().tableau.apiVersion,
        subjectConfigured: Boolean(getConfig().tableau.defaultSubject.trim()),
        scopesConfigured: getConfig().tableau.scopes,
        connectedAppConfigured: {
          clientId: false,
          secretId: false,
          secretValue: false,
        },
      },
      reachability: {
        ok: false,
        error: safeErrorDetails(error),
      },
      authentication: {
        ok: false,
        error: safeErrorDetails(error),
      },
    };
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

function buildInputImageObjectKey(uploadId: string, fileName?: string): string {
  const safeName = sanitizeFileName(fileName?.trim() || "image");
  return `client-input-images/${uploadId}/${safeName}`;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function buildAttachedInputImage(
  request: ActionRunRequest,
): ActionRunResult["attachedImage"] | undefined {
  const inputImage = request.inputImage;
  const objectKey =
    inputImage?.objectKey?.trim() ??
    request.clientContext?.photo?.objectKey?.trim();
  if (!objectKey) {
    return undefined;
  }

  const contentType =
    inputImage?.contentType?.trim().toLowerCase() ||
    request.clientContext?.photo?.contentType?.trim().toLowerCase() ||
    request.clientContext?.photo?.mimeType?.trim().toLowerCase();

  if (!contentType) {
    return undefined;
  }

  return {
    source: "original_input_image",
    objectKey,
    contentType,
    ...(inputImage?.bytes ? { byteLength: inputImage.bytes } : {}),
    ...(inputImage?.width ? { width: inputImage.width } : {}),
    ...(inputImage?.height ? { height: inputImage.height } : {}),
  };
}
