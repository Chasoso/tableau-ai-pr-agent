import { ChatJobRepository } from "./chatJobRepository";
import type {
  ActionRunGetResponse,
  ActionRunRecord,
  ActionRunResult,
} from "../types/actionRun";
import type { ChatJobRecord } from "../types/chatJob";
import type { ChatJobStage } from "../services/chatProgress";
import type { ChatJobStatus } from "../types/chatJob";

export class ActionRunRepository {
  constructor(private readonly chatJobRepository = new ChatJobRepository()) {}

  async create(record: ActionRunRecord): Promise<void> {
    await this.chatJobRepository.create(record as unknown as ChatJobRecord);
  }

  async get(actionRunId: string): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.get(actionRunId);
    return record ? (record as unknown as ActionRunRecord) : null;
  }

  async claim(
    actionRunId: string,
    input: {
      workerId: string;
      nowIso: string;
      leaseExpiresAtIso: string;
    },
  ): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.claim(actionRunId, input);
    return record ? (record as unknown as ActionRunRecord) : null;
  }

  async updateProgress(
    actionRunId: string,
    input: {
      stage: ChatJobStage;
      message: string;
      toolName?: string;
      debug?: Record<string, unknown>;
      status?: ChatJobStatus;
      maxMessages?: number;
      leaseExpiresAtIso?: string;
    },
  ): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.updateProgress(
      actionRunId,
      input,
    );
    return record ? (record as unknown as ActionRunRecord) : null;
  }

  async markCompleted(input: {
    actionRunId: string;
    result: ActionRunResult;
  }): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.markCompleted({
      jobId: input.actionRunId,
      result: input.result as unknown as NonNullable<ChatJobRecord["result"]>,
    });
    return record ? (record as unknown as ActionRunRecord) : null;
  }

  async updateResult(input: {
    actionRunId: string;
    result: ActionRunResult;
  }): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.updateResult({
      jobId: input.actionRunId,
      result: input.result as unknown as NonNullable<ChatJobRecord["result"]>,
    });
    return record ? (record as unknown as ActionRunRecord) : null;
  }

  async markFailed(input: {
    actionRunId: string;
    error: ChatJobRecord["error"];
  }): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.markFailed({
      jobId: input.actionRunId,
      error: input.error,
    });
    return record ? (record as unknown as ActionRunRecord) : null;
  }

  async toPublicView(record: ActionRunRecord): Promise<ActionRunGetResponse> {
    const publicView = await this.chatJobRepository.toPublicView(
      record as unknown as ChatJobRecord,
    );

    return {
      actionRunId: publicView.jobId,
      jobType: "action_run",
      status: publicView.status,
      stage: publicView.stage,
      progressMessages: publicView.progressMessages,
      ...(publicView.result
        ? {
            result:
              publicView.result as unknown as ActionRunGetResponse["result"],
          }
        : {}),
      ...(publicView.error ? { error: publicView.error } : {}),
      createdAt: publicView.createdAt,
      updatedAt: publicView.updatedAt,
      ...(publicView.startedAt ? { startedAt: publicView.startedAt } : {}),
      ...(publicView.completedAt
        ? { completedAt: publicView.completedAt }
        : {}),
      expiresAt: publicView.expiresAt,
      ownerType: publicView.ownerType as ActionRunGetResponse["ownerType"],
    };
  }
}
