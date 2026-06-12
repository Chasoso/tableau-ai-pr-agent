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
import { ChatJobRepository } from "../repositories/chatJobRepository";
import { createChatService } from "./chatService";
import type { AuthenticatedUser } from "../types/auth";
import type { ChatRequest } from "../types/chat";
import type {
  ChatJobAuthSnapshot,
  ChatJobCreateResponse,
  ChatJobGetResponse,
  ChatJobRecord,
  ChatJobResult,
} from "../types/chatJob";
import type { ChatProgressReporter } from "./chatProgress";

export type ChatJobOwnerContext = {
  ownerKey: string;
  ownerToken?: string;
};

const repository = new ChatJobRepository();

export class ChatJobService {
  async createChatJob(input: {
    request: ChatRequest;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
    requestId?: string;
  }): Promise<ChatJobCreateResponse> {
    const config = getConfig();
    const ownerContext = resolveOwnerContext({
      authenticatedUser: input.authenticatedUser,
      headers: input.headers,
    });
    const authContextSnapshot = buildAuthSnapshot(input.authenticatedUser);
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const record: ChatJobRecord = {
      jobId,
      jobType: "chat",
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
          message: "分析を開始しました",
        },
      ],
      request: input.request,
      createdAt,
      updatedAt: createdAt,
      expiresAt:
        Math.floor(Date.now() / 1000) + Math.max(60, config.chatJob.ttlSeconds),
    };

    await repository.create(record);
    logInfo("chat.job.created", {
      jobId,
      requestId: input.requestId,
      authenticated: Boolean(input.authenticatedUser),
      authSnapshotPresent: Boolean(authContextSnapshot),
      ownerKeyHash: safeHash(ownerContext.ownerKey),
      sessionId: input.request.sessionId,
    });

    if (!config.chatJob.workerFunctionName) {
      logWarn("chat.job.dispatch_inline", {
        jobId,
        requestId: input.requestId,
      });
      void this.processChatJob(
        {
          jobId,
        },
        input.authenticatedUser,
      ).catch((error) => {
        logError("chat.job.inline_worker_failed", {
          jobId,
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
        logError("chat.job.dispatch_failed", {
          jobId,
          ...safeErrorDetails(error),
        });
        await repository.markFailed({
          jobId,
          error: {
            code: "dispatch_failed",
            message: "Worker Lambda invocation failed.",
            details: safeErrorDetails(error),
          },
        });
        throw new Error("Failed to start chat job.");
      }
    }

    return {
      jobId,
      status: "queued",
      stage: "queued",
      pollUrl: `/chat-jobs/${jobId}`,
      retryAfterMs: 1500,
      ...(ownerContext.ownerToken
        ? { ownerToken: ownerContext.ownerToken }
        : {}),
    };
  }

  async getChatJob(input: {
    jobId: string;
    authenticatedUser?: AuthenticatedUser;
    headers?: Record<string, string | undefined>;
  }): Promise<ChatJobGetResponse> {
    const record = await repository.get(input.jobId);
    if (!record) {
      throw new Error("Chat job not found.");
    }

    this.assertOwner(record, input.authenticatedUser, input.headers);
    return repository.toPublicView(record);
  }

  async processChatJob(
    input: {
      jobId: string;
      getRemainingTimeInMillis?: () => number;
    },
    authenticatedUser?: AuthenticatedUser,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const leaseExpiresAtIso = new Date(
      Date.now() + Math.max(30, getConfig().chatJob.leaseSeconds) * 1000,
    ).toISOString();
    const claimed = await repository.claim(input.jobId, {
      workerId: `worker-${randomUUID()}`,
      nowIso,
      leaseExpiresAtIso,
    });

    if (!claimed) {
      logWarn("chat.job.claim_skipped", {
        jobId: input.jobId,
      });
      return;
    }

    logInfo("chat.job.claimed", {
      jobId: input.jobId,
      ownerType: claimed.ownerType,
      attemptCount: claimed.attemptCount ?? 1,
      stage: claimed.stage,
      status: claimed.status,
    });

    const progressReporter = createRepositoryProgressReporter(input.jobId);
    const chatService = createChatService();
    const effectiveAuthenticatedUser =
      authenticatedUser ?? buildAuthenticatedUserFromSnapshot(claimed);
    const conversationOwnerKey =
      claimed.ownerType === "authenticated"
        ? (effectiveAuthenticatedUser?.userId ??
          claimed.ownerUserId ??
          claimed.ownerKey)
        : claimed.ownerKey;

    if (claimed.ownerType === "authenticated" && !effectiveAuthenticatedUser) {
      logWarn("chat.job.auth_context_missing", {
        jobId: input.jobId,
        ownerUserId: claimed.ownerUserId,
        authSnapshotPresent: Boolean(claimed.authContextSnapshot),
      });
    }

    try {
      const response = await chatService.generateAnswer(
        claimed.request,
        effectiveAuthenticatedUser,
        {
          getRemainingTimeInMillis: input.getRemainingTimeInMillis,
          progressReporter,
          conversationOwnerKey,
        },
      );

      await repository.markCompleted({
        jobId: input.jobId,
        result: summarizeChatResponse(response),
      });

      logInfo("chat.job.completed", {
        jobId: input.jobId,
        sessionId: response.sessionId,
        messageId: response.messageId,
      });

      await progressReporter.report({
        stage: "completed",
        message: "分析が完了しました。",
        debug: {
          sessionId: response.sessionId,
          messageId: response.messageId,
        },
      });
    } catch (error) {
      logError("chat.job.failed", {
        jobId: input.jobId,
        ...safeErrorDetails(error),
      });
      await repository.markFailed({
        jobId: input.jobId,
        error: {
          code:
            error instanceof Error && error.name ? error.name : "worker_failed",
          message:
            error instanceof Error
              ? error.message
              : "Chat job processing failed.",
          details: safeErrorDetails(error),
        },
      });
      await progressReporter.report({
        stage: "failed",
        message: "分析に失敗しました。",
        debug: safeErrorDetails(error),
      });
    }
  }

  async reportProgress(
    jobId: string,
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
      status?: ChatJobRecord["status"];
    },
  ): Promise<void> {
    await repository.updateProgress(jobId, {
      ...update,
      maxMessages: getConfig().chatJob.progressMessageLimit,
    });
  }

  private assertOwner(
    record: ChatJobRecord,
    authenticatedUser?: AuthenticatedUser,
    headers?: Record<string, string | undefined>,
  ): void {
    const expectedOwnerKey = resolveOwnerContext({
      authenticatedUser,
      headers,
    }).ownerKey;

    if (record.ownerKey !== expectedOwnerKey) {
      throw new Error("You do not have access to this chat job.");
    }
  }
}

function createRepositoryProgressReporter(jobId: string): ChatProgressReporter {
  return {
    async report(update) {
      try {
        await repository.updateProgress(jobId, {
          stage: update.stage,
          message: update.message,
          toolName: update.toolName,
          debug: update.debug,
          status:
            update.stage === "completed"
              ? "completed"
              : update.stage === "failed"
                ? "failed"
                : update.stage === "finalizing"
                  ? "finalizing"
                  : "running",
          maxMessages: getConfig().chatJob.progressMessageLimit,
          leaseExpiresAtIso: new Date(
            Date.now() + Math.max(30, getConfig().chatJob.leaseSeconds) * 1000,
          ).toISOString(),
        });
      } catch (error) {
        logWarn("chat.job.progress_update_failed", {
          jobId,
          ...safeErrorDetails(error),
        });
      }
    },
  };
}

function summarizeChatResponse(response: {
  answer: string;
  sessionId: string;
  messageId: string;
  notionPostIdeaDraft?: ChatJobResult["notionPostIdeaDraft"];
  dashboardContextPatch?: ChatJobResult["dashboardContextPatch"];
  debug?: ChatJobResult["debug"];
}): ChatJobResult {
  return {
    answer: response.answer,
    sessionId: response.sessionId,
    messageId: response.messageId,
    ...(response.notionPostIdeaDraft
      ? { notionPostIdeaDraft: response.notionPostIdeaDraft }
      : {}),
    ...(response.dashboardContextPatch
      ? { dashboardContextPatch: response.dashboardContextPatch }
      : {}),
    ...(response.debug ? { debug: response.debug } : {}),
  };
}

export function resolveOwnerContext(input: {
  authenticatedUser?: AuthenticatedUser;
  headers?: Record<string, string | undefined>;
}): ChatJobOwnerContext {
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
  record: Pick<ChatJobRecord, "authContextSnapshot">,
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
