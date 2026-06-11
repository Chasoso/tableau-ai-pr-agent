import type { EncryptedValue } from "./notion";

export type CognitoPopupAuthStatus =
  | "pending"
  | "completed"
  | "failed"
  | "consumed";

export type FrontendAuthSessionPayload = {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  email?: string;
  nickname?: string;
};

export type CognitoPopupStartRequest = {
  redirectAfter?: string;
};

export type CognitoPopupStartResponse = {
  transactionId: string;
  pollToken: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type CognitoPopupStatusResponse =
  | {
      status: "pending";
    }
  | {
      status: "completed";
      session: FrontendAuthSessionPayload;
    }
  | {
      status: "failed" | "consumed";
      message: string;
    };

export type CognitoAuthTransactionRecord = {
  transactionId: string;
  state: string;
  pollTokenHash: string;
  redirectAfter?: string;
  status: CognitoPopupAuthStatus;
  codeVerifier: EncryptedValue;
  session?: EncryptedValue;
  errorCode?: string;
  errorMessageSafe?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
};
