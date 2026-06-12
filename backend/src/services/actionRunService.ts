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
import { ActionRunRepository } from "../repositories/actionRunRepository";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunCreateResponse,
  ActionRunGetResponse,
  ActionRunRecord,
  ActionRunRequest,
} from "../types/actionRun";

const repository = new ActionRunRepository();
const analysisService = new ActionRunAnalysisService();

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
        Math.floor(Date.now() / 1000) + Math.max(60, config.chatJob.ttlSeconds),
    };

    await repository.create(record);
    logInfo("action_run.created", {
      actionRunId: jobId,
      requestId: input.requestId,
      authenticated: Boolean(input.authenticatedUser),
      ownerKeyHash: safeHash(ownerContext.ownerKey),
      postType: input.request.postType,
      eventName: input.request.eventName,
    });

    if (!config.chatJob.workerFunctionName) {
      logWarn("action_run.dispatch_inline", {
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
          actionRunId: jobId,
          ...safeErrorDetails(error),
        });
      });
    } else {
      try {
        await getLambdaClient().send(
          new InvokeCommand({
            FunctionName: config.chatJob.workerFunctionName,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ jobId })),
          }),
        );
      } catch (error) {
        logError("action_run.dispatch_failed", {
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
      Date.now() + Math.max(30, getConfig().chatJob.leaseSeconds) * 1000,
    ).toISOString();
    const claimed = await repository.claim(input.actionRunId, {
      workerId: `worker-${randomUUID()}`,
      nowIso,
      leaseExpiresAtIso,
    });

    if (!claimed) {
      logWarn("action_run.claim_skipped", {
        actionRunId: input.actionRunId,
      });
      return;
    }

    logInfo("action_run.claimed", {
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

      await repository.markCompleted({
        actionRunId: input.actionRunId,
        result: response,
      });

      await this.reportProgress(input.actionRunId, {
        stage: "completed",
        message: "Fixed analysis results stored.",
        status: "completed",
        debug: {
          summaryLength: response.summary.length,
          sectionCount: response.analysisSections?.length ?? 0,
        },
      });
      logInfo("action_run.completed", {
        actionRunId: input.actionRunId,
        sectionCount: response.analysisSections?.length ?? 0,
      });
    } catch (error) {
      logError("action_run.failed", {
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
      maxMessages: getConfig().chatJob.progressMessageLimit,
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

  const ownerToken =
    getHeader(input.headers, getConfig().chatJob.ownerTokenHeaderName) ||
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
