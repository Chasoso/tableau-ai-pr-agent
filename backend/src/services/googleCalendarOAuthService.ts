import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails, safeHash } from "../logging";
import { GoogleCalendarRepository } from "../repositories/googleCalendarRepository";
import type { AuthenticatedUser } from "../types/auth";
import type {
  GoogleCalendarConnectionRecord,
  GoogleCalendarPopupStartRequest,
  GoogleCalendarPopupStartResponse,
  GoogleCalendarPopupStatusResponse,
  GoogleCalendarStatusResponse,
} from "../types/googleCalendarAuth";
import { encryptGoogleToken } from "../security/googleCalendarTokenCrypto";

type GoogleTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export class GoogleCalendarOAuthService {
  constructor(private readonly repository = new GoogleCalendarRepository()) {}

  async getStatus(
    user: AuthenticatedUser | undefined,
  ): Promise<GoogleCalendarStatusResponse> {
    requireUser(user);
    const userHash = safeHash(user.userId);
    let connection: GoogleCalendarConnectionRecord | null = null;
    try {
      logInfo("google.oauth.status.connection_lookup.start", {
        userHash,
      });
      connection = await this.repository.getConnection(user.userId);
      logInfo("google.oauth.status.connection_lookup.completed", {
        userHash,
        hasConnection: Boolean(connection),
        connectionStatus: connection?.status ?? "disconnected",
      });
    } catch {
      logWarn("google.oauth.status.connection_lookup.failed", {
        userHash,
      });
      return {
        connected: false,
        status: "disconnected",
      };
    }
    return {
      connected: Boolean(connection?.status === "connected"),
      status: connection?.status ?? "disconnected",
      connectedAt: connection?.createdAt,
      email: connection?.email,
      scopes: connection?.scopes,
    };
  }

  async startPopupAuth(
    user: AuthenticatedUser | undefined,
    input: GoogleCalendarPopupStartRequest,
  ): Promise<GoogleCalendarPopupStartResponse> {
    validateGoogleCalendarOAuthConfiguration();
    requireUser(user);
    const userHash = safeHash(user.userId);
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

    logInfo("google.oauth.start.requested", {
      userHash,
      hasRedirectAfter: Boolean(input.redirectAfter),
      transactionIdHash: safeHash(transactionId),
      stateHash: safeHash(state),
    });

    await this.repository.putOAuthState({
      transactionId,
      state,
      userId: user.userId,
      pollTokenHash: hashString(pollToken),
      codeVerifier,
      redirectAfter: input.redirectAfter,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAtEpoch,
      status: "pending",
    });

    logInfo("google.oauth.start.created", {
      userHash,
      transactionIdHash: safeHash(transactionId),
      stateHash: safeHash(state),
      hasRedirectAfter: Boolean(input.redirectAfter),
      ttlSeconds: getConfig().auth.popup.transactionTtlSeconds,
    });

    const authUrl = new URL(getGoogleAuthUrl());
    authUrl.searchParams.set("client_id", getConfig().calendar.google.clientId);
    authUrl.searchParams.set(
      "redirect_uri",
      getConfig().calendar.google.redirectUri,
    );
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      getConfig().calendar.google.scopes.join(" "),
    );
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
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
    validateGoogleCalendarOAuthConfiguration();
    if (!input.code || !input.state) {
      throw new Error("Missing Google OAuth callback parameters.");
    }

    logInfo("google.oauth.callback.received", {
      stateHash: safeHash(input.state),
      hasCode: Boolean(input.code),
    });
    const transaction = await this.repository.getOAuthStateByState(input.state);
    if (!transaction) {
      logWarn("google.oauth.callback.state_not_found", {
        stateHash: safeHash(input.state),
      });
      throw new Error("Google OAuth state not found or already used.");
    }

    try {
      if (transaction.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new Error("Google OAuth state expired.");
      }

      logInfo("google.oauth.callback.token_exchange.start", {
        transactionIdHash: safeHash(transaction.transactionId),
        userHash: safeHash(transaction.userId),
      });
      const tokenData = await exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: transaction.codeVerifier,
      });

      if (!tokenData.refresh_token) {
        throw new Error(
          "Google OAuth token response did not include a refresh token.",
        );
      }

      const encryptedRefresh = await encryptGoogleToken(
        tokenData.refresh_token,
      );
      const nowIso = new Date().toISOString();
      const connection: GoogleCalendarConnectionRecord = {
        userId: transaction.userId,
        connectionId: getDefaultConnectionId(),
        refreshTokenCiphertext: encryptedRefresh.ciphertext,
        refreshTokenIv: encryptedRefresh.iv,
        refreshTokenAuthTag: encryptedRefresh.authTag,
        createdAt: transaction.createdAt,
        updatedAt: nowIso,
        lastUsedAt: nowIso,
        status: "connected",
        scopes: tokenData.scope?.split(/\s+/u).filter(Boolean),
      };
      logInfo("google.oauth.callback.connection.persist.start", {
        transactionIdHash: safeHash(transaction.transactionId),
        userHash: safeHash(transaction.userId),
      });
      await this.repository.putConnection(connection);
      logInfo("google.oauth.callback.connection.persist.completed", {
        transactionIdHash: safeHash(transaction.transactionId),
        userHash: safeHash(transaction.userId),
      });
      await this.repository.updateOAuthState(transaction.transactionId, {
        status: "completed",
        updatedAt: nowIso,
        errorMessageSafe: undefined,
      });

      logInfo("google.oauth.callback.completed", {
        transactionIdHash: safeHash(transaction.transactionId),
        userHash: safeHash(transaction.userId),
        hasRefreshToken: true,
      });

      return { redirectAfter: transaction.redirectAfter };
    } catch (error) {
      logWarn("google.oauth.callback.failed", {
        transactionIdHash: safeHash(transaction.transactionId),
        stateHash: safeHash(input.state),
        ...safeErrorDetails(error),
      });
      await this.repository.updateOAuthState(transaction.transactionId, {
        status: "failed",
        updatedAt: new Date().toISOString(),
        errorMessageSafe:
          error instanceof Error
            ? error.message
            : "Google OAuth callback failed.",
      });
      logWarn("google.oauth.callback.failed", {
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
  }): Promise<GoogleCalendarPopupStatusResponse> {
    validateGoogleCalendarOAuthConfiguration();
    if (!input.transactionId) {
      throw new Error("transactionId is required.");
    }

    logInfo("google.oauth.popup.status.requested", {
      transactionIdHash: safeHash(input.transactionId),
      hasPollToken: Boolean(input.pollToken),
    });

    const transaction = await this.repository.getOAuthStateByTransactionId(
      input.transactionId,
    );
    if (!transaction) {
      logWarn("google.oauth.popup.status.not_found", {
        transactionIdHash: safeHash(input.transactionId),
      });
      return {
        status: "failed",
        message: "Authentication transaction was not found.",
      };
    }

    if (
      !input.pollToken ||
      hashString(input.pollToken) !== transaction.pollTokenHash
    ) {
      logWarn("google.oauth.popup.status.invalid_token", {
        transactionIdHash: safeHash(input.transactionId),
      });
      return {
        status: "failed",
        message: "Authentication transaction token is invalid.",
      };
    }

    if (transaction.status === "completed") {
      logInfo("google.oauth.popup.status.completed", {
        transactionIdHash: safeHash(input.transactionId),
      });
      return { status: "completed", connected: true };
    }

    if (transaction.status === "failed" || transaction.status === "consumed") {
      logWarn("google.oauth.popup.status.failed", {
        transactionIdHash: safeHash(input.transactionId),
        status: transaction.status,
      });
      return {
        status: transaction.status,
        message: transaction.errorMessageSafe || "Authentication failed.",
      };
    }

    logInfo("google.oauth.popup.status.pending", {
      transactionIdHash: safeHash(input.transactionId),
    });
    return { status: "pending" };
  }

  async disconnect(user: AuthenticatedUser | undefined): Promise<void> {
    requireUser(user);
    await this.repository.deleteConnection(user.userId);
  }
}

export function validateGoogleCalendarOAuthConfiguration(): void {
  const config = getConfig().calendar.google;
  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.redirectUri ||
    !config.connectionsTableName ||
    !config.oauthStatesTableName ||
    !config.tokenEncryptionKeyParam
  ) {
    throw new Error("Google Calendar OAuth is not configured.");
  }
}

function getDefaultConnectionId(): string {
  return "GOOGLE_CALENDAR#DEFAULT";
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  const config = getConfig().calendar.google;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    logWarn("google.oauth.callback.token_exchange.failed", {
      statusCode: response.status,
      responseBodyHash: safeHash(raw),
      responseBodyLength: raw.length,
    });
    throw new Error(
      `Google OAuth token exchange failed with status ${response.status}.`,
    );
  }

  return (await response.json()) as GoogleTokenResponse;
}

function requireUser(
  user: AuthenticatedUser | undefined,
): asserts user is AuthenticatedUser {
  if (!user?.userId) {
    throw new Error("Google Calendar connection requires a signed-in user.");
  }
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

function getGoogleAuthUrl(): string {
  return "https://accounts.google.com/o/oauth2/v2/auth";
}
