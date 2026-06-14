import { env } from "../env";
import type {
  ActionRunApprovalRequest,
  ActionRunApprovalResponse,
  ActionRunCreateResponse,
  ActionRunGetResponse,
  ActionRunRequest,
} from "../types/actionRun";

const apiBaseUrl = () => env.apiBaseUrl.replace(/\/$/, "");

export async function createActionRun(
  request: ActionRunRequest,
  accessToken?: string,
  ownerToken?: string,
): Promise<ActionRunCreateResponse> {
  const response = await fetch(`${apiBaseUrl()}/action-runs`, {
    method: "POST",
    headers: buildJsonHeaders(accessToken, ownerToken),
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<ActionRunCreateResponse>;
}

export async function getActionRun(
  actionRunId: string,
  accessToken?: string,
  ownerToken?: string,
): Promise<ActionRunGetResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/action-runs/${encodeURIComponent(actionRunId)}`,
    {
      method: "GET",
      headers: buildHeaders(accessToken, ownerToken),
    },
  );

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<ActionRunGetResponse>;
}

export async function approveActionRun(
  actionRunId: string,
  request: ActionRunApprovalRequest,
  accessToken?: string,
  ownerToken?: string,
): Promise<ActionRunApprovalResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/action-runs/${encodeURIComponent(actionRunId)}/approval`,
    {
      method: "POST",
      headers: buildJsonHeaders(accessToken, ownerToken),
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<ActionRunApprovalResponse>;
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
