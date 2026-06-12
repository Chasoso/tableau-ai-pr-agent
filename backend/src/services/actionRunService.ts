import { randomUUID } from "node:crypto";
import { getConfig } from "../config";
import { resolveOwnerContext } from "./chatJobService";
import { logInfo, safeHash } from "../logging";
import { ActionRunRepository } from "../repositories/actionRunRepository";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunCreateResponse,
  ActionRunGetResponse,
  ActionRunRecord,
  ActionRunRequest,
} from "../types/actionRun";

const repository = new ActionRunRepository();

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
