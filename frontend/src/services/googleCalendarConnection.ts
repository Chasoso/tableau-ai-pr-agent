import {
  getGoogleCalendarPopupStatus,
  getGoogleCalendarStatus,
  startGoogleCalendarPopupAuth,
} from "../api/googleCalendarAuthApi";

export type GoogleCalendarConnectionStatus = {
  connected: boolean;
  status: "connected" | "disconnected" | "refresh_failed";
};

export type GoogleCalendarPopupResult = {
  connected: boolean;
};

export async function loadGoogleCalendarConnectionStatus(
  accessToken?: string,
  ownerToken?: string,
): Promise<GoogleCalendarConnectionStatus> {
  const response = await getGoogleCalendarStatus(accessToken, ownerToken);
  return {
    connected: response.connected,
    status: response.status,
  };
}

export async function startGoogleCalendarConnection(
  accessToken?: string,
  redirectAfter?: string,
  ownerToken?: string,
): Promise<GoogleCalendarPopupResult> {
  const popup = window.open(
    "",
    "tableau-ai-pr-agent-google-connect",
    "popup,width=520,height=720",
  );
  if (!popup) {
    throw new Error(
      "Google 接続用のポップアップを開けませんでした。ポップアップを許可してください。",
    );
  }

  popup.focus();
  let startResponse;
  try {
    startResponse = await startGoogleCalendarPopupAuth(
      { redirectAfter },
      accessToken,
      ownerToken,
    );
  } catch (error) {
    try {
      popup.close();
    } catch {
      // Ignore popup close failures on startup error.
    }
    throw error;
  }
  popup.location.replace(startResponse.authorizationUrl);
  await waitForGoogleConnectionStatus(
    startResponse.transactionId,
    startResponse.pollToken,
  );
  return { connected: true };
}

async function waitForGoogleConnectionStatus(
  transactionId: string,
  pollToken: string,
): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 90_000;
  let delayMs = 750;

  for (;;) {
    const status = await getGoogleCalendarPopupStatus(transactionId, pollToken);
    if (status.status === "completed") {
      return;
    }

    if (status.status === "failed" || status.status === "consumed") {
      throw new Error(status.message);
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        "Google 接続がタイムアウトしました。もう一度お試しください。",
      );
    }

    await sleep(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.35), 2500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
