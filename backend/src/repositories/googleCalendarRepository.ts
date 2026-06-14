import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getDynamoDbClient } from "../aws/dynamodb";
import { getConfig } from "../config";
import type {
  GoogleCalendarConnectionRecord,
  GoogleCalendarOAuthStateRecord,
} from "../types/googleCalendarAuth";

const DEFAULT_CONNECTION_ID = "GOOGLE_CALENDAR#DEFAULT";
const STATE_INDEX_NAME = "StateIndex";

export class GoogleCalendarRepository {
  async getConnection(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID,
  ): Promise<GoogleCalendarConnectionRecord | null> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.connectionsTableName,
      "GOOGLE_CALENDAR_CONNECTIONS_TABLE",
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

    return unmarshall(response.Item) as GoogleCalendarConnectionRecord;
  }

  async putConnection(record: GoogleCalendarConnectionRecord): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.connectionsTableName,
      "GOOGLE_CALENDAR_CONNECTIONS_TABLE",
    );
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async deleteConnection(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID,
  ): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.connectionsTableName,
      "GOOGLE_CALENDAR_CONNECTIONS_TABLE",
    );
    await getDynamoDbClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ userId, connectionId }),
      }),
    );
  }

  async putOAuthState(record: GoogleCalendarOAuthStateRecord): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.oauthStatesTableName,
      "GOOGLE_CALENDAR_OAUTH_STATES_TABLE",
    );
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async getOAuthStateByTransactionId(
    transactionId: string,
  ): Promise<GoogleCalendarOAuthStateRecord | null> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.oauthStatesTableName,
      "GOOGLE_CALENDAR_OAUTH_STATES_TABLE",
    );
    const response = await getDynamoDbClient().send(
      new GetItemCommand({
        TableName: tableName,
        Key: marshall({ transactionId }),
      }),
    );

    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as GoogleCalendarOAuthStateRecord;
  }

  async getOAuthStateByState(
    state: string,
  ): Promise<GoogleCalendarOAuthStateRecord | null> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.oauthStatesTableName,
      "GOOGLE_CALENDAR_OAUTH_STATES_TABLE",
    );
    const response = await getDynamoDbClient().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: STATE_INDEX_NAME,
        KeyConditionExpression: "#state = :state",
        ExpressionAttributeNames: {
          "#state": "state",
        },
        ExpressionAttributeValues: marshall({
          ":state": state,
        }) as Record<string, AttributeValue>,
        Limit: 1,
      }),
    );

    const item = response.Items?.[0];
    if (!item) {
      return null;
    }

    return unmarshall(item) as GoogleCalendarOAuthStateRecord;
  }

  async updateOAuthState(
    transactionId: string,
    values: Partial<
      Pick<
        GoogleCalendarOAuthStateRecord,
        "status" | "errorMessageSafe" | "updatedAt"
      >
    >,
  ): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.oauthStatesTableName,
      "GOOGLE_CALENDAR_OAUTH_STATES_TABLE",
    );
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
      return;
    }

    await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ transactionId }),
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: marshall(attributeValues, {
          removeUndefinedValues: true,
        }),
      }),
    );
  }

  async deleteOAuthState(transactionId: string): Promise<void> {
    const tableName = requireConfigValue(
      getConfig().calendar.google.oauthStatesTableName,
      "GOOGLE_CALENDAR_OAUTH_STATES_TABLE",
    );
    await getDynamoDbClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ transactionId }),
      }),
    );
  }
}

function requireConfigValue(
  value: string | undefined,
  envName: string,
): string {
  if (!value) {
    throw new Error(`${envName} is required for Google Calendar integration.`);
  }

  return value;
}

export function getDefaultGoogleCalendarConnectionId(): string {
  return DEFAULT_CONNECTION_ID;
}
