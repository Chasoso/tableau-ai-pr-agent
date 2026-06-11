import { PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getConfig } from "../config";
import { getDynamoDbClient } from "../aws/dynamodb";
import type { ChatHistoryRecord } from "../types/chat";

export interface ChatHistoryRepository {
  save(record: ChatHistoryRecord): Promise<void>;
  listRecentBySession(input: {
    sessionId: string;
    ownerUserId?: string;
    limit: number;
  }): Promise<ChatHistoryRecord[]>;
}

export class InMemoryChatHistoryRepository implements ChatHistoryRepository {
  private readonly records: ChatHistoryRecord[] = [];

  async save(record: ChatHistoryRecord): Promise<void> {
    this.records.push(record);
  }

  async listRecentBySession(input: {
    sessionId: string;
    ownerUserId?: string;
    limit: number;
  }): Promise<ChatHistoryRecord[]> {
    if (!input.ownerUserId) {
      return [];
    }

    return this.records
      .filter(
        (record) =>
          record.sessionId === input.sessionId &&
          record.ownerUserId === input.ownerUserId,
      )
      .slice(-input.limit);
  }

  getAll(): ChatHistoryRecord[] {
    return [...this.records];
  }
}

export class DynamoDbChatHistoryRepository implements ChatHistoryRepository {
  constructor(private readonly tableName: string) {}

  async save(record: ChatHistoryRecord): Promise<void> {
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshall({
          pk: buildSessionPartitionKey(record.ownerUserId, record.sessionId),
          sk: `MESSAGE#${record.createdAt}#${record.messageId}`,
          ...record,
        }),
      }),
    );
  }

  async listRecentBySession(input: {
    sessionId: string;
    ownerUserId?: string;
    limit: number;
  }): Promise<ChatHistoryRecord[]> {
    if (!input.ownerUserId) {
      return [];
    }

    const response = await getDynamoDbClient().send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: marshall({
          ":pk": buildSessionPartitionKey(input.ownerUserId, input.sessionId),
        }),
        ScanIndexForward: false,
        Limit: input.limit,
      }),
    );

    return (response.Items ?? [])
      .map((item) => unmarshall(item) as ChatHistoryRecord)
      .reverse();
  }
}

const inMemoryRepository = new InMemoryChatHistoryRepository();

export function createChatHistoryRepository(): ChatHistoryRepository {
  const config = getConfig();
  if (config.useInMemoryRepository) {
    return inMemoryRepository;
  }

  if (!config.chatHistoryTableName) {
    throw new Error(
      "CHAT_HISTORY_TABLE_NAME is required when USE_IN_MEMORY_REPOSITORY=false.",
    );
  }

  return new DynamoDbChatHistoryRepository(config.chatHistoryTableName);
}

function buildSessionPartitionKey(
  ownerUserId: string | null | undefined,
  sessionId: string,
): string {
  if (!ownerUserId) {
    return `ANON_SESSION#${sessionId}`;
  }

  return `USER#${ownerUserId}#SESSION#${sessionId}`;
}
