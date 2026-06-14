import { env } from "../env";
import type {
  CalendarResolveRequest,
  CalendarResolveResponse,
} from "../types/calendar";

const apiBaseUrl = () => env.apiBaseUrl.replace(/\/$/, "");

export async function resolveCalendarEventContext(
  request: CalendarResolveRequest,
  accessToken?: string,
  ownerToken?: string,
): Promise<CalendarResolveResponse> {
  const response = await fetch(`${apiBaseUrl()}/calendar/resolve`, {
    method: "POST",
    headers: buildJsonHeaders(accessToken, ownerToken),
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<CalendarResolveResponse>;
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
