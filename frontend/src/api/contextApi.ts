import { env } from "../env";
import type { ContextRequest, ContextResponse } from "../types/chat";

export async function enrichDashboardContext(
  request: ContextRequest,
  authToken?: string,
): Promise<ContextResponse> {
  const response = await fetch(`${env.apiBaseUrl.replace(/\/$/, "")}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({
      message: `Request failed with status ${response.status}`,
    }));
    throw new Error(
      body.message ?? `Request failed with status ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      "Context API returned a non-JSON response. Check VITE_API_BASE_URL and /api routing.",
    );
  }

  return response.json() as Promise<ContextResponse>;
}
