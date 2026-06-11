import { env } from "../env";
import type {
  ChatJobCreateResponse,
  ChatJobGetResponse,
  ChatRequest,
  ChatResponse,
} from "../types/chat";

const apiBaseUrl = () => env.apiBaseUrl.replace(/\/$/, "");

export async function sendChatQuestion(
  request: ChatRequest,
  accessToken?: string,
): Promise<ChatResponse> {
  const response = await fetch(`${apiBaseUrl()}/chat`, {
    method: "POST",
    headers: buildJsonHeaders(accessToken),
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
      "Chat API returned a non-JSON response. Check VITE_API_BASE_URL and ensure it points to API Gateway or /api.",
    );
  }

  return response.json() as Promise<ChatResponse>;
}

export async function createChatJob(
  request: ChatRequest,
  accessToken?: string,
  ownerToken?: string,
): Promise<ChatJobCreateResponse> {
  const response = await fetch(`${apiBaseUrl()}/chat-jobs`, {
    method: "POST",
    headers: buildJsonHeaders(accessToken, ownerToken),
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<ChatJobCreateResponse>;
}

export async function getChatJob(
  jobId: string,
  accessToken?: string,
  ownerToken?: string,
): Promise<ChatJobGetResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/chat-jobs/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
      headers: buildHeaders(accessToken, ownerToken),
    },
  );

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<ChatJobGetResponse>;
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
