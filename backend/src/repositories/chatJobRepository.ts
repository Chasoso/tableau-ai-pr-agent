import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getConfig } from "../config";
import { getDynamoDbClient } from "../aws/dynamodb";
import type {
  ChatJobGetResponse,
  ChatJobRecord,
  ChatJobResult,
  ChatJobStatus,
} from "../types/chatJob";
import type { ChatJobStage } from "../services/chatProgress";

export class ChatJobRepository {
  async create(record: ChatJobRecord): Promise<void> {
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: getTableName(),
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async get(jobId: string): Promise<ChatJobRecord | null> {
    const response = await getDynamoDbClient().send(
      new GetItemCommand({
        TableName: getTableName(),
        Key: marshall({ jobId }),
      }),
    );

    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as ChatJobRecord;
  }

  async claim(
    jobId: string,
    input: {
      workerId: string;
      nowIso: string;
      leaseExpiresAtIso: string;
    },
  ): Promise<ChatJobRecord | null> {
    try {
      const response = await getDynamoDbClient().send(
        new UpdateItemCommand({
          TableName: getTableName(),
          Key: marshall({ jobId }),
          ConditionExpression:
            "#status = :queued OR (#status = :running AND #leaseExpiresAt < :now)",
          UpdateExpression:
            "SET #status = :running, #stage = :runningStage, #workerId = :workerId, #startedAt = if_not_exists(#startedAt, :now), #updatedAt = :now, #leaseExpiresAt = :leaseExpiresAt ADD #attemptCount :one",
          ExpressionAttributeNames: {
            "#status": "status",
            "#stage": "stage",
            "#workerId": "workerId",
            "#startedAt": "startedAt",
            "#updatedAt": "updatedAt",
            "#leaseExpiresAt": "leaseExpiresAt",
            "#attemptCount": "attemptCount",
          },
          ExpressionAttributeValues: marshall(
            {
              ":queued": "queued",
              ":running": "running",
              ":runningStage": "loading_history",
              ":workerId": input.workerId,
              ":now": input.nowIso,
              ":leaseExpiresAt": input.leaseExpiresAtIso,
              ":one": 1,
            },
            { removeUndefinedValues: true },
          ),
          ReturnValues: "ALL_NEW",
        }),
      );

      return response.Attributes
        ? (unmarshall(response.Attributes) as ChatJobRecord)
        : null;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return null;
      }

      throw error;
    }
  }

  async updateProgress(
    jobId: string,
    input: {
      stage: ChatJobStage;
      message: string;
      toolName?: string;
      debug?: Record<string, unknown>;
      status?: ChatJobStatus;
      maxMessages?: number;
      leaseExpiresAtIso?: string;
    },
  ): Promise<ChatJobRecord | null> {
    const current = await this.get(jobId);
    if (!current) {
      return null;
    }

    const progressMessages = [
      ...current.progressMessages,
      {
        at: new Date().toISOString(),
        stage: input.stage,
        message: input.message,
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.debug ? { debug: input.debug } : {}),
      },
    ].slice(-(input.maxMessages ?? getConfig().chatJob.progressMessageLimit));

    return this.update(jobId, {
      status: input.status ?? current.status,
      stage: input.stage,
      progressMessages,
      updatedAt: new Date().toISOString(),
      ...(input.leaseExpiresAtIso
        ? { leaseExpiresAt: input.leaseExpiresAtIso }
        : {}),
    });
  }

  async markFinalizing(jobId: string): Promise<ChatJobRecord | null> {
    return this.update(jobId, {
      status: "finalizing",
      stage: "finalizing",
      updatedAt: new Date().toISOString(),
    });
  }

  async markCompleted(input: {
    jobId: string;
    result: ChatJobResult;
  }): Promise<ChatJobRecord | null> {
    const nowIso = new Date().toISOString();
    const ttlSeconds = Math.max(60, getConfig().chatJob.ttlSeconds);
    return this.update(input.jobId, {
      status: "completed",
      stage: "completed",
      result: input.result,
      completedAt: nowIso,
      updatedAt: nowIso,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  }

  async updateResult(input: {
    jobId: string;
    result: ChatJobResult;
  }): Promise<ChatJobRecord | null> {
    return this.update(input.jobId, {
      result: input.result,
      updatedAt: new Date().toISOString(),
    });
  }

  async markFailed(input: {
    jobId: string;
    error: ChatJobRecord["error"];
  }): Promise<ChatJobRecord | null> {
    const nowIso = new Date().toISOString();
    const ttlSeconds = Math.max(60, getConfig().chatJob.ttlSeconds);
    return this.update(input.jobId, {
      status: "failed",
      stage: "failed",
      error: input.error,
      completedAt: nowIso,
      updatedAt: nowIso,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  }

  async toPublicView(job: ChatJobRecord): Promise<ChatJobGetResponse> {
    return {
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progressMessages: job.progressMessages,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      expiresAt: job.expiresAt,
      ownerType: job.ownerType,
    };
  }

  private async update(
    jobId: string,
    values: Partial<ChatJobRecord>,
  ): Promise<ChatJobRecord | null> {
    const attributeNames: Record<string, string> = {};
    const attributeValues: Record<string, unknown> = {};
    const updates: string[] = [];

    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        continue;
      }

      const nameKey = `#${key}`;
      const valueKey = `:${key}`;
      attributeNames[nameKey] = key;
      attributeValues[valueKey] = value;
      updates.push(`${nameKey} = ${valueKey}`);
    }

    if (updates.length === 0) {
      return this.get(jobId);
    }

    const response = await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: getTableName(),
        Key: marshall({ jobId }),
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: marshall(attributeValues, {
          removeUndefinedValues: true,
        }),
        ReturnValues: "ALL_NEW",
      }),
    );

    return response.Attributes
      ? (unmarshall(response.Attributes) as ChatJobRecord)
      : null;
  }
}

function getTableName(): string {
  const tableName = getConfig().chatJobsTableName;
  if (!tableName) {
    throw new Error("CHAT_JOBS_TABLE_NAME is required.");
  }

  return tableName;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
