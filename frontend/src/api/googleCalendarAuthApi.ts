import { env } from "../env";
import type {
  GoogleCalendarPopupStartResponse,
  GoogleCalendarPopupStatusResponse,
  GoogleCalendarStatusResponse,
} from "../types/googleCalendarAuth";

const apiBaseUrl = () => env.apiBaseUrl.replace(/\/$/, "");

export async function getGoogleCalendarStatus(
  accessToken?: string,
  ownerToken?: string,
): Promise<GoogleCalendarStatusResponse> {
  const response = await fetch(`${apiBaseUrl()}/auth/google/status`, {
    method: "GET",
    headers: buildHeaders(accessToken, ownerToken),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<GoogleCalendarStatusResponse>;
}

export async function startGoogleCalendarPopupAuth(
  input: { redirectAfter?: string },
  accessToken?: string,
  ownerToken?: string,
): Promise<GoogleCalendarPopupStartResponse> {
  const response = await fetch(`${apiBaseUrl()}/auth/google/popup/start`, {
    method: "POST",
    headers: buildJsonHeaders(accessToken, ownerToken),
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<GoogleCalendarPopupStartResponse>;
}

export async function getGoogleCalendarPopupStatus(
  transactionId: string,
  pollToken: string,
): Promise<GoogleCalendarPopupStatusResponse> {
  const url = new URL(
    `${apiBaseUrl()}/auth/google/popup/status`,
    window.location.origin,
  );
  url.searchParams.set("transactionId", transactionId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Auth-Poll-Token": pollToken,
    },
  });

  const body = (await response.json().catch(() => ({
    message: `Request failed with status ${response.status}`,
  }))) as GoogleCalendarPopupStatusResponse | { message?: string };

  if (!response.ok && (!("status" in body) || body.status !== "failed")) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body as GoogleCalendarPopupStatusResponse;
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
