import {
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
  CognitoAuthTransactionRecord,
  CognitoPopupAuthStatus,
} from "../types/cognitoPopupAuth";

const STATE_INDEX_NAME = "StateIndex";

export class CognitoAuthTransactionRepository {
  async putTransaction(record: CognitoAuthTransactionRecord): Promise<void> {
    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: getTableName(),
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async getTransaction(
    transactionId: string,
  ): Promise<CognitoAuthTransactionRecord | null> {
    const response = await getDynamoDbClient().send(
      new GetItemCommand({
        TableName: getTableName(),
        Key: marshall({ transactionId }),
      }),
    );

    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as CognitoAuthTransactionRecord;
  }

  async getTransactionByState(
    state: string,
  ): Promise<CognitoAuthTransactionRecord | null> {
    const response = await getDynamoDbClient().send(
      new QueryCommand({
        TableName: getTableName(),
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

    return unmarshall(item) as CognitoAuthTransactionRecord;
  }

  async markCompleted(input: {
    transactionId: string;
    session: CognitoAuthTransactionRecord["session"];
  }): Promise<void> {
    await this.updateTransaction(input.transactionId, {
      status: "completed",
      session: input.session,
      errorCode: undefined,
      errorMessageSafe: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  async markFailed(input: {
    transactionId: string;
    errorCode?: string;
    errorMessageSafe?: string;
  }): Promise<void> {
    await this.updateTransaction(input.transactionId, {
      status: "failed",
      errorCode: input.errorCode,
      errorMessageSafe: input.errorMessageSafe,
      updatedAt: new Date().toISOString(),
    });
  }

  async markConsumed(transactionId: string): Promise<void> {
    await this.updateTransaction(transactionId, {
      status: "consumed",
      updatedAt: new Date().toISOString(),
    });
  }

  private async updateTransaction(
    transactionId: string,
    values: Partial<
      Pick<
        CognitoAuthTransactionRecord,
        "status" | "session" | "errorCode" | "errorMessageSafe" | "updatedAt"
      >
    >,
  ): Promise<void> {
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
        TableName: getTableName(),
        Key: marshall({ transactionId }),
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: marshall(attributeValues, {
          removeUndefinedValues: true,
        }),
      }),
    );
  }
}

function getTableName(): string {
  const tableName = getConfig().auth.popup.transactionsTableName;
  if (!tableName) {
    throw new Error(
      "COGNITO_AUTH_TRANSACTIONS_TABLE is required for Cognito popup auth.",
    );
  }

  return tableName;
}

export function isTerminalPopupAuthStatus(
  status: CognitoPopupAuthStatus,
): boolean {
  return status === "completed" || status === "failed" || status === "consumed";
}
