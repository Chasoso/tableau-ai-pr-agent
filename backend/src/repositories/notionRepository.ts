import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getConfig } from "../config";
import { getDynamoDbClient } from "../aws/dynamodb";
import type {
  NotionConnectionRecord,
  NotionOAuthStateRecord,
} from "../types/notion";

const DEFAULT_CONNECTION_ID = "NOTION#DEFAULT";

export class NotionRepository {
  async getConnection(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID,
  ): Promise<NotionConnectionRecord | null> {
    const tableName = requireConfigValue(
      getConfig().notion.connectionsTableName,
      "NOTION_CONNECTIONS_TABLE",
    );
    const response = await getDynamoDbClient().send(
      new GetItemCommand({
        TableName: tableName,
        Key: marshall({ userId, connectionId }),
      }),
    );

    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as NotionConnectionRecord;
  }

  async putConnection(record: NotionConnectionRecord): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().notion.connectionsTableName,
      "NOTION_CONNECTIONS_TABLE",
    );
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async updateConnectionSettings(input: {
    userId: string;
    connectionId?: string;
    targetParentPageId?: string;
    targetDatabaseId?: string;
  }): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().notion.connectionsTableName,
      "NOTION_CONNECTIONS_TABLE",
    );
    const connectionId = input.connectionId ?? DEFAULT_CONNECTION_ID;
    await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ userId: input.userId, connectionId }),
        UpdateExpression:
          "SET #targetParentPageId = :targetParentPageId, #targetDatabaseId = :targetDatabaseId, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#targetParentPageId": "targetParentPageId",
          "#targetDatabaseId": "targetDatabaseId",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: marshall({
          ":targetParentPageId": input.targetParentPageId ?? null,
          ":targetDatabaseId": input.targetDatabaseId ?? null,
          ":updatedAt": new Date().toISOString(),
        }),
      }),
    );
  }

  async deleteConnection(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID,
  ): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().notion.connectionsTableName,
      "NOTION_CONNECTIONS_TABLE",
    );
    await getDynamoDbClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ userId, connectionId }),
      }),
    );
  }

  async putOAuthState(record: NotionOAuthStateRecord): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().notion.oauthStatesTableName,
      "NOTION_OAUTH_STATES_TABLE",
    );
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async getOAuthState(state: string): Promise<NotionOAuthStateRecord | null> {
    const tableName = requireConfigValue(
      getConfig().notion.oauthStatesTableName,
      "NOTION_OAUTH_STATES_TABLE",
    );
    const response = await getDynamoDbClient().send(
      new GetItemCommand({
        TableName: tableName,
        Key: marshall({ state }),
      }),
    );
    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as NotionOAuthStateRecord;
  }

  async deleteOAuthState(state: string): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().notion.oauthStatesTableName,
      "NOTION_OAUTH_STATES_TABLE",
    );
    await getDynamoDbClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ state }),
      }),
    );
  }
}

function requireConfigValue(
  value: string | undefined,
  envName: string,
): string {
  if (!value) {
    throw new Error(`${envName} is required for Notion MCP integration.`);
  }

  return value;
}

export function getDefaultNotionConnectionId(): string {
  return DEFAULT_CONNECTION_ID;
}
