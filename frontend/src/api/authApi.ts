import { env } from "../env";
import type { AuthSession } from "../types/auth";

export type PopupAuthStartResponse = {
  transactionId: string;
  pollToken: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type PopupAuthStatusResponse =
  | { status: "pending" }
  | { status: "completed"; session: AuthSession }
  | { status: "failed" | "consumed"; message: string };

export async function startPopupAuth(input: {
  redirectAfter?: string;
}): Promise<PopupAuthStartResponse> {
  const response = await fetch(
    `${env.apiBaseUrl.replace(/\/$/, "")}/auth/cognito/popup/start`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    throw await toApiError(response);
  }

  return (await response.json()) as PopupAuthStartResponse;
}

export async function getPopupAuthStatus(
  transactionId: string,
  pollToken: string,
): Promise<PopupAuthStatusResponse> {
  const url = new URL(
    `${env.apiBaseUrl.replace(/\/$/, "")}/auth/cognito/popup/status`,
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
  }))) as PopupAuthStatusResponse | { message?: string };

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

  return body as PopupAuthStatusResponse;
}

async function toApiError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({
    message: `Request failed with status ${response.status}`,
  }))) as { message?: string };
  return new Error(
    body.message ?? `Request failed with status ${response.status}`,
  );
}
