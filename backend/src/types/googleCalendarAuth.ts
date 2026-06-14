export type GoogleCalendarConnectionStatus =
  | "connected"
  | "disconnected"
  | "refresh_failed";

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export type GoogleCalendarConnectionRecord = {
  userId: string;
  connectionId: string;
  refreshTokenCiphertext: string;
  refreshTokenIv: string;
  refreshTokenAuthTag: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  status: GoogleCalendarConnectionStatus;
  scopes?: string[];
  email?: string;
};

export type GoogleCalendarOAuthStateRecord = {
  transactionId: string;
  state: string;
  userId: string;
  pollTokenHash: string;
  codeVerifier: string;
  redirectAfter?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  status: "pending" | "completed" | "failed" | "consumed";
  errorMessageSafe?: string;
};

export type GoogleCalendarPopupStartRequest = {
  redirectAfter?: string;
};

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
  status: GoogleCalendarConnectionStatus;
  connectedAt?: string;
  email?: string;
  scopes?: string[];
};
