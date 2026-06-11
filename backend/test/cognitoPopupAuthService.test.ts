import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CognitoPopupAuthService } from "../src/auth/cognitoPopupAuthService";
import type { CognitoAuthTransactionRecord } from "../src/types/cognitoPopupAuth";

const cryptoMocks = vi.hoisted(() => ({
  encryptPopupCodeVerifier: vi.fn(),
  decryptPopupCodeVerifier: vi.fn(),
  encryptPopupSession: vi.fn(),
  decryptPopupSession: vi.fn(),
}));

vi.mock("../src/auth/cognitoPopupAuthCrypto", () => ({
  encryptPopupCodeVerifier: cryptoMocks.encryptPopupCodeVerifier,
  decryptPopupCodeVerifier: cryptoMocks.decryptPopupCodeVerifier,
  encryptPopupSession: cryptoMocks.encryptPopupSession,
  decryptPopupSession: cryptoMocks.decryptPopupSession,
}));

describe("CognitoPopupAuthService", () => {
  const originalEnv = {
    AUTH_REQUIRED: process.env.AUTH_REQUIRED,
    COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    COGNITO_DOMAIN: process.env.COGNITO_DOMAIN,
    COGNITO_POPUP_REDIRECT_URI: process.env.COGNITO_POPUP_REDIRECT_URI,
    COGNITO_AUTH_TRANSACTION_TTL_SECONDS:
      process.env.COGNITO_AUTH_TRANSACTION_TTL_SECONDS,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_REQUIRED = "true";
    process.env.COGNITO_CLIENT_ID = "client-123";
    process.env.COGNITO_DOMAIN =
      "https://demo.auth.ap-northeast-1.amazoncognito.com";
    process.env.COGNITO_POPUP_REDIRECT_URI =
      "https://example.com/api/auth/cognito/callback";
    process.env.COGNITO_AUTH_TRANSACTION_TTL_SECONDS = "600";

    cryptoMocks.encryptPopupCodeVerifier.mockResolvedValue({
      ciphertext: "enc-verifier",
      iv: "iv",
      authTag: "tag",
    });
    cryptoMocks.decryptPopupCodeVerifier.mockResolvedValue("plain-verifier");
    cryptoMocks.encryptPopupSession.mockResolvedValue({
      ciphertext: "enc-session",
      iv: "iv-session",
      authTag: "tag-session",
    });
    cryptoMocks.decryptPopupSession.mockResolvedValue({
      accessToken: "access-token",
      idToken: "id-token",
      expiresAt: Date.now() + 3600_000,
      email: "user@example.com",
      nickname: "Chasoso",
    });

    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("creates a pending popup auth transaction and authorization URL", async () => {
    const repository = createRepositoryStub();
    const service = new CognitoPopupAuthService(repository as never);

    const result = await service.startPopupAuth({
      redirectAfter: "/dashboard",
    });

    expect(repository.putTransaction).toHaveBeenCalledTimes(1);
    const record = repository.putTransaction.mock
      .calls[0][0] as CognitoAuthTransactionRecord;
    expect(record.status).toBe("pending");
    expect(record.redirectAfter).toBe("/dashboard");
    expect(record.codeVerifier.ciphertext).toBe("enc-verifier");
    expect(result.authorizationUrl).toContain(
      "https://demo.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize",
    );
    expect(result.authorizationUrl).toContain(
      "redirect_uri=https%3A%2F%2Fexample.com%2Fapi%2Fauth%2Fcognito%2Fcallback",
    );
    expect(result.transactionId).toBe(record.transactionId);
    expect(result.pollToken).toBeTruthy();
  });

  it("exchanges code on callback and stores an encrypted session", async () => {
    const repository = createRepositoryStub();
    const state = "txn.state";
    repository.getTransactionByState.mockResolvedValue({
      transactionId: "txn-1",
      state,
      pollTokenHash: "hash",
      status: "pending",
      codeVerifier: {
        ciphertext: "enc-verifier",
        iv: "iv",
        authTag: "tag",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    } satisfies CognitoAuthTransactionRecord);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          id_token: createFakeJwt({
            email: "user@example.com",
            nickname: "Chasoso",
          }),
          expires_in: 3600,
          token_type: "Bearer",
        }),
      }),
    );

    const service = new CognitoPopupAuthService(repository as never);
    await service.handlePopupCallback({ code: "auth-code", state });

    expect(repository.markCompleted).toHaveBeenCalledTimes(1);
    expect(cryptoMocks.encryptPopupSession).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("returns completed status when transaction session is available", async () => {
    const repository = createRepositoryStub();
    const service = new CognitoPopupAuthService(repository as never);

    const start = await service.startPopupAuth({});
    const putRecord = repository.putTransaction.mock
      .calls[0][0] as CognitoAuthTransactionRecord;
    repository.getTransaction.mockResolvedValue({
      ...putRecord,
      status: "completed",
      session: {
        ciphertext: "enc-session",
        iv: "iv-session",
        authTag: "tag-session",
      },
    });

    const result = await service.getPopupAuthStatus({
      transactionId: start.transactionId,
      pollToken: start.pollToken,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.session.email).toBe("user@example.com");
    }
  });

  it("rejects status lookups when poll token does not match", async () => {
    const repository = createRepositoryStub();
    const service = new CognitoPopupAuthService(repository as never);

    const start = await service.startPopupAuth({});
    const putRecord = repository.putTransaction.mock
      .calls[0][0] as CognitoAuthTransactionRecord;
    repository.getTransaction.mockResolvedValue(putRecord);

    const result = await service.getPopupAuthStatus({
      transactionId: start.transactionId,
      pollToken: "wrong-token",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain("invalid");
    }
  });
});

function createRepositoryStub() {
  return {
    putTransaction: vi.fn(),
    getTransaction: vi.fn(),
    getTransactionByState: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    markConsumed: vi.fn(),
  };
}

function createFakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}
