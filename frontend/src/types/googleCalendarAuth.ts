export type GoogleCalendarPopupStartResponse = {
  transactionId: string;
  pollToken: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type GoogleCalendarPopupStatusResponse =
  | { status: "pending" }
  | { status: "completed"; connected: true }
  | { status: "failed" | "consumed"; message: string };

export type GoogleCalendarStatusResponse = {
  connected: boolean;
  status: "connected" | "disconnected" | "refresh_failed";
  connectedAt?: string;
  email?: string;
  scopes?: string[];
};
