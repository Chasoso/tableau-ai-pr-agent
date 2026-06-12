import { env } from "../env";
import type {
  TechPlayPreviewRequest,
  TechPlayPreviewResponse,
} from "../types/techplay";

const apiBaseUrl = () => env.apiBaseUrl.replace(/\/$/, "");

export async function previewTechPlayEvent(
  request: TechPlayPreviewRequest,
  accessToken?: string,
  ownerToken?: string,
): Promise<TechPlayPreviewResponse> {
  const response = await fetch(`${apiBaseUrl()}/techplay/preview`, {
    method: "POST",
    headers: buildJsonHeaders(accessToken, ownerToken),
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<TechPlayPreviewResponse>;
}

function buildJsonHeaders(accessToken?: string, ownerToken?: string) {
  return {
    "Content-Type": "application/json",
    ...buildHeaders(accessToken, ownerToken),
  };
}

function buildHeaders(accessToken?: string, ownerToken?: string) {
  return {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(ownerToken ? { "X-Chat-Owner-Token": ownerToken } : {}),
  };
}

async function toApiError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({
    message: `Request failed with status ${response.status}`,
  }))) as { message?: string };
  return new Error(
    body.message ?? `Request failed with status ${response.status}`,
  );
}
