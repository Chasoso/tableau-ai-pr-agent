import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

let client: DynamoDBClient | null = null;

export function getDynamoDbClient(): DynamoDBClient {
  if (!client) {
    client = new DynamoDBClient({});
  }

  return client;
}
