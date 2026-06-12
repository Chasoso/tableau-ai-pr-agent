import { ChatJobRepository } from "./chatJobRepository";
import type { ActionRunGetResponse, ActionRunRecord } from "../types/actionRun";
import type { ChatJobRecord } from "../types/chatJob";

export class ActionRunRepository {
  constructor(private readonly chatJobRepository = new ChatJobRepository()) {}

  async create(record: ActionRunRecord): Promise<void> {
    await this.chatJobRepository.create(record as unknown as ChatJobRecord);
  }

  async get(actionRunId: string): Promise<ActionRunRecord | null> {
    const record = await this.chatJobRepository.get(actionRunId);
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
