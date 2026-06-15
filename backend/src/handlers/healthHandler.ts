import { getConfig } from "../config";
import type { ApiGatewayProxyEvent, ApiGatewayProxyResult } from "../types/api";
import { runTableauConnectivityDiagnostics } from "../services/tableauConnectivityDiagnostics";

export async function handler(
  event?: ApiGatewayProxyEvent,
): Promise<ApiGatewayProxyResult> {
  const query = event?.queryStringParameters ?? {};
  const diagnosticsEnabled =
    process.env.TABLEAU_CONNECTIVITY_DIAGNOSTICS === "true";
  const shouldIncludeTableauDiagnostics =
    diagnosticsEnabled &&
    (query.tableau === "1" ||
      query.tableau === "true" ||
      query.diagnostic === "tableau");

  const body = shouldIncludeTableauDiagnostics
    ? {
        status: "ok",
        tableau: await runTableauConnectivityDiagnostics(),
      }
    : {
        status: "ok",
      };

  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": getConfig().corsAllowedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}
