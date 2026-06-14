import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails, safeHash } from "../logging";
import {
  decryptPopupCodeVerifier,
  decryptPopupSession,
  encryptPopupCodeVerifier,
  encryptPopupSession,
} from "./cognitoPopupAuthCrypto";
import { CognitoAuthTransactionRepository } from "../repositories/cognitoAuthTransactionRepository";
import type {
  CognitoAuthTransactionRecord,
  CognitoPopupStartRequest,
  CognitoPopupStartResponse,
  CognitoPopupStatusResponse,
  FrontendAuthSessionPayload,
} from "../types/cognitoPopupAuth";

type CognitoTokenResponse = {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
};

export class CognitoPopupAuthService {
  constructor(
    private readonly repository = new CognitoAuthTransactionRepository(),
  ) {}

  async startPopupAuth(
    input: CognitoPopupStartRequest,
  ): Promise<CognitoPopupStartResponse> {
    validatePopupAuthConfiguration();

    const transactionId = randomUUID();
    const state = `${transactionId}.${randomBase64Url(18)}`;
    const pollToken = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const now = new Date();
    const expiresAtEpoch = Math.floor(
      (now.getTime() + getConfig().auth.popup.transactionTtlSeconds * 1000) /
        1000,
    );

    const record: CognitoAuthTransactionRecord = {
      transactionId,
      state,
      pollTokenHash: hashString(pollToken),
      redirectAfter: input.redirectAfter,
      status: "pending",
      codeVerifier: await encryptPopupCodeVerifier(codeVerifier),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAtEpoch,
    };

    await this.repository.putTransaction(record);
    logInfo("auth.popup.start.created", {
      transactionIdHash: safeHash(transactionId),
      stateHash: safeHash(state),
      hasRedirectAfter: Boolean(input.redirectAfter),
      expiresAt: expiresAtEpoch,
    });

    const authUrl = new URL(`${getCognitoDomain()}/oauth2/authorize`);
    authUrl.searchParams.set("client_id", getConfig().auth.cognitoClientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email");
    authUrl.searchParams.set(
      "redirect_uri",
      getConfig().auth.popup.redirectUri,
    );
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("code_challenge", codeChallenge);

    return {
      transactionId,
      pollToken,
      authorizationUrl: authUrl.toString(),
      expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
    };
  }

  async handlePopupCallback(input: {
    code?: string;
    state?: string;
  }): Promise<{ redirectAfter?: string }> {
    validatePopupAuthConfiguration();
    if (!input.code || !input.state) {
      throw new Error("Missing Cognito popup callback parameters.");
    }

    const transaction = await this.repository.getTransactionByState(
      input.state,
    );
    if (!transaction) {
      throw new Error("Cognito popup auth transaction was not found.");
    }

    logInfo("auth.popup.callback.received", {
      transactionIdHash: safeHash(transaction.transactionId),
      stateHash: safeHash(input.state),
    });

    try {
      if (transaction.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new Error("Cognito popup auth transaction expired.");
      }

      const codeVerifier = await decryptPopupCodeVerifier(
        transaction.codeVerifier,
      );
      const tokenData = await exchangeAuthorizationCode({
        code: input.code,
        codeVerifier,
      });

      const session = buildFrontendSession(tokenData);
      await this.repository.markCompleted({
        transactionId: transaction.transactionId,
        session: await encryptPopupSession(session),
      });

      logInfo("auth.popup.callback.completed", {
        transactionIdHash: safeHash(transaction.transactionId),
        sessionExpiresAt: session.expiresAt,
        emailHash: safeHash(session.email),
      });

      return { redirectAfter: transaction.redirectAfter };
    } catch (error) {
      await this.repository.markFailed({
        transactionId: transaction.transactionId,
        errorCode: "callback_failed",
        errorMessageSafe:
          error instanceof Error
            ? error.message
            : "Authentication callback failed.",
      });
      logWarn("auth.popup.callback.failed", {
        transactionIdHash: safeHash(transaction.transactionId),
        stateHash: safeHash(input.state),
        ...safeErrorDetails(error),
      });
      throw error;
    }
  }

  async getPopupAuthStatus(input: {
    transactionId: string;
    pollToken?: string;
  }): Promise<CognitoPopupStatusResponse> {
    validatePopupAuthConfiguration();
    if (!input.transactionId) {
      throw new Error("transactionId is required.");
    }

    const transaction = await this.repository.getTransaction(
      input.transactionId,
    );
    if (!transaction) {
      return {
        status: "failed",
        message: "Authentication transaction was not found.",
      };
    }

    if (
      !input.pollToken ||
      hashString(input.pollToken) !== transaction.pollTokenHash
    ) {
      return {
        status: "failed",
        message: "Authentication transaction token is invalid.",
      };
    }

    logInfo("auth.popup.status.polled", {
      transactionIdHash: safeHash(input.transactionId),
      status: transaction.status,
    });

    if (transaction.status === "completed" && transaction.session) {
      return {
        status: "completed",
        session: await decryptPopupSession(transaction.session),
      };
    }

    if (transaction.status === "failed" || transaction.status === "consumed") {
      return {
        status: transaction.status,
        message: transaction.errorMessageSafe || "Authentication failed.",
      };
    }

    return { status: "pending" };
  }
}

export function validatePopupAuthConfiguration(): void {
  const config = getConfig().auth;
  if (!config.required) {
    throw new Error("Cognito authentication is not enabled.");
  }
  if (
    !config.cognitoClientId ||
    !config.cognitoDomain ||
    !config.popup.redirectUri
  ) {
    throw new Error("Cognito popup auth is not configured.");
  }
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<CognitoTokenResponse> {
  const config = getConfig().auth;
  const response = await fetch(`${getCognitoDomain()}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.cognitoClientId,
      code: input.code,
      redirect_uri: config.popup.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    logWarn("auth.popup.callback.token_exchange.failed", {
      statusCode: response.status,
      responseBodyHash: safeHash(raw),
      responseBodyLength: raw.length,
    });
    throw new Error(
      `Cognito popup token exchange failed with status ${response.status}.`,
    );
  }

  logInfo("auth.popup.callback.token_exchanged", {
    redirectUriHostHash: safeHash(new URL(config.popup.redirectUri).host),
  });
  return (await response.json()) as CognitoTokenResponse;
}

function buildFrontendSession(
  tokenData: CognitoTokenResponse,
): FrontendAuthSessionPayload {
  const claims = decodeIdTokenClaims(tokenData.id_token);
  return {
    accessToken: tokenData.access_token,
    idToken: tokenData.id_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    email: claims.email,
    nickname: claims.nickname,
  };
}

function decodeIdTokenClaims(idToken: string): {
  email?: string;
  nickname?: string;
} {
  const [, payload] = idToken.split(".");
  if (!payload) {
    return {};
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      Buffer.from(addBase64Padding(normalized), "base64").toString("utf8"),
    ) as {
      email?: string;
      nickname?: string;
    };
    return {
      email: decoded.email,
      nickname: decoded.nickname,
    };
  } catch {
    return {};
  }
}

function addBase64Padding(value: string): string {
  return value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
}

function getCognitoDomain(): string {
  return getConfig().auth.cognitoDomain.replace(/\/$/, "");
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = createHash("sha256").update(value).digest("base64");
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
