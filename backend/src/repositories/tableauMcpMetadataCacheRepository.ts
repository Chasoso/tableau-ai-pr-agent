import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getDynamoDbClient } from "../aws/dynamodb";
import { getConfig } from "../config";

export type TableauMcpMetadataCacheRecord = {
  cacheKey: string;
  subjectHash: string;
  toolName: string;
  argsHash: string;
  result: unknown;
  createdAt: string;
  expiresAt: number;
};

export class TableauMcpMetadataCacheRepository {
  async get(cacheKey: string): Promise<unknown | null> {
    const tableName = getTableName();
    if (!tableName) {
      return null;
    }

    const response = await getDynamoDbClient().send(
      new GetItemCommand({
        TableName: tableName,
        Key: marshall({ cacheKey }),
      }),
    );

    if (!response.Item) {
      return null;
    }

    const record = unmarshall(response.Item) as TableauMcpMetadataCacheRecord;
    if (
      typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return record.result;
  }

  async put(record: TableauMcpMetadataCacheRecord): Promise<void> {
    const tableName = getTableName();
    if (!tableName) {
      return;
    }

    await getDynamoDbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }
}

function getTableName(): string | undefined {
  return getConfig().tableau.mcp.metadataCacheTableName;
}
