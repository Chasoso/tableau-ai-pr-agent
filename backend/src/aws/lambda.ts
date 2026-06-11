import { LambdaClient } from "@aws-sdk/client-lambda";

let client: LambdaClient | null = null;

export function getLambdaClient(): LambdaClient {
  if (!client) {
    client = new LambdaClient({});
  }

  return client;
}
