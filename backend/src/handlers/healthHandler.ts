import { getConfig } from "../config";
import type { ApiGatewayProxyResult } from "../types/api";

export async function handler(): Promise<ApiGatewayProxyResult> {
  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": getConfig().corsAllowedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "ok" }),
  };
}
