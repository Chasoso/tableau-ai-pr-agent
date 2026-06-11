import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails, safeHash } from "../logging";
import type {
  NotionConnectionRecord,
  NotionOAuthStateRecord,
} from "../types/notion";
import {
  getDefaultNotionConnectionId,
  NotionRepository,
} from "../repositories/notionRepository";
import { decryptToken, encryptToken } from "./notionTokenCrypto";

type NotionTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
  owner?: {
    type?: string;
    user?: {
      id?: string;
    };
  };
  duplicated_template_id?: string;
};

type OAuthMetadata = {
  resource?: string;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
};

let cachedMcpOAuthMetadata: OAuthMetadata | null = null;

type OAuthClientContext = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  clientSource: "dynamic_registration" | "static_env";
};

export class NotionOAuthService {
  constructor(private readonly repository = new NotionRepository()) {}

  async buildAuthorizationUrl(input: {
    userId: string;
    redirectAfter?: string;
  }): Promise<{ authorizationUrl: string }> {
    const config = getConfig();
    validateOauthConfiguration();
    const oauthMetadata = await discoverMcpOAuthMetadata(config.notion.mcpUrl, {
      fallbackAuthorizationEndpoint: config.notion.oauthAuthorizeUrl,
      fallbackTokenEndpoint: config.notion.oauthTokenUrl,
    });
    const oauthClient = await resolveOAuthClientContext({
      metadata: oauthMetadata,
      redirectUri: config.notion.redirectUri,
      staticClientId: config.notion.oauthClientId,
      staticClientSecret: config.notion.oauthClientSecret,
    });

    const codeVerifier = createCodeVerifier();
    const state = randomUUID();
    const createdAt = new Date();
    const expiresAtEpoch = Math.floor(
      (createdAt.getTime() + config.notion.oauthStateTtlSeconds * 1000) / 1000,
    );
    const stateRecord: NotionOAuthStateRecord = {
      state,
      userId: input.userId,
      codeVerifier,
      oauthClientId: oauthClient.clientId,
      oauthTokenEndpoint: oauthClient.tokenEndpoint,
      oauthAuthorizationEndpoint: oauthClient.authorizationEndpoint,
      oauthTokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
      oauthResource: oauthClient.resource,
      redirectAfter: input.redirectAfter,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAtEpoch,
    };
    if (oauthClient.clientSecret) {
      const encryptedClientSecret = await encryptToken(
        oauthClient.clientSecret,
      );
      stateRecord.oauthClientSecretCiphertext =
        encryptedClientSecret.ciphertext;
      stateRecord.oauthClientSecretIv = encryptedClientSecret.iv;
      stateRecord.oauthClientSecretAuthTag = encryptedClientSecret.authTag;
    }
    await this.repository.putOAuthState(stateRecord);
    logInfo("notion.oauth.connect.started", {
      userHash: safeHash(input.userId),
      stateHash: safeHash(state),
      ttlSeconds: config.notion.oauthStateTtlSeconds,
      hasRedirectAfter: Boolean(input.redirectAfter),
      oauthClientSource: oauthClient.clientSource,
    });

    const codeChallenge = createCodeChallenge(codeVerifier);
    const authorizeUrl = new URL(oauthClient.authorizationEndpoint);
    authorizeUrl.searchParams.set("owner", "user");
    authorizeUrl.searchParams.set("client_id", oauthClient.clientId);
    authorizeUrl.searchParams.set("redirect_uri", config.notion.redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", oauthClient.resource);

    return { authorizationUrl: authorizeUrl.toString() };
  }

  async handleCallback(input: {
    code?: string;
    state?: string;
  }): Promise<{ redirectTo: string }> {
    const config = getConfig();
    validateOauthConfiguration();
    if (!input.code || !input.state) {
      throw new Error("Missing OAuth callback parameters.");
    }

    const stateRecord = await this.repository.getOAuthState(input.state);
    if (!stateRecord) {
      throw new Error("OAuth state not found or already used.");
    }
    logInfo("notion.oauth.callback.state_loaded", {
      stateHash: safeHash(input.state),
      userHash: safeHash(stateRecord.userId),
      hasRedirectAfter: Boolean(stateRecord.redirectAfter),
    });

    try {
      const nowEpoch = Math.floor(Date.now() / 1000);
      if (stateRecord.expiresAt < nowEpoch) {
        throw new Error("OAuth state expired.");
      }

      const oauthClientSecret = await decryptOptionalToken({
        ciphertext: stateRecord.oauthClientSecretCiphertext,
        iv: stateRecord.oauthClientSecretIv,
        authTag: stateRecord.oauthClientSecretAuthTag,
      });

      const tokenData = await exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: stateRecord.codeVerifier,
        clientId: stateRecord.oauthClientId,
        clientSecret: oauthClientSecret,
        tokenEndpoint: stateRecord.oauthTokenEndpoint,
        tokenEndpointAuthMethod: stateRecord.oauthTokenEndpointAuthMethod,
        resource: stateRecord.oauthResource,
      });
      logInfo("notion.oauth.callback.token_exchanged", {
        stateHash: safeHash(input.state),
        hasRefreshToken: Boolean(tokenData.refresh_token),
        hasWorkspaceId: Boolean(tokenData.workspace_id),
      });

      const accessEncrypted = await encryptToken(tokenData.access_token);
      const refreshEncrypted = tokenData.refresh_token
        ? await encryptToken(tokenData.refresh_token)
        : undefined;
      const nowIso = new Date().toISOString();
      const encryptedConnectionClientSecret = oauthClientSecret
        ? await encryptToken(oauthClientSecret)
        : undefined;
      const connection: NotionConnectionRecord = {
        userId: stateRecord.userId,
        connectionId: getDefaultNotionConnectionId(),
        notionWorkspaceId: tokenData.workspace_id,
        notionWorkspaceName: tokenData.workspace_name,
        notionBotId: tokenData.bot_id,
        notionUserId: tokenData.owner?.user?.id,
        accessTokenCiphertext: accessEncrypted.ciphertext,
        accessTokenIv: accessEncrypted.iv,
        accessTokenAuthTag: accessEncrypted.authTag,
        refreshTokenCiphertext: refreshEncrypted?.ciphertext,
        refreshTokenIv: refreshEncrypted?.iv,
        refreshTokenAuthTag: refreshEncrypted?.authTag,
        oauthClientId: stateRecord.oauthClientId,
        oauthClientSecretCiphertext:
          encryptedConnectionClientSecret?.ciphertext,
        oauthClientSecretIv: encryptedConnectionClientSecret?.iv,
        oauthClientSecretAuthTag: encryptedConnectionClientSecret?.authTag,
        oauthTokenEndpoint: stateRecord.oauthTokenEndpoint,
        oauthAuthorizationEndpoint: stateRecord.oauthAuthorizationEndpoint,
        oauthTokenEndpointAuthMethod: stateRecord.oauthTokenEndpointAuthMethod,
        oauthResource: stateRecord.oauthResource,
        expiresAt: tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : undefined,
        scopes: [],
        targetParentPageId: config.notion.defaultTargetParentPageId,
        targetDatabaseId: config.notion.defaultTargetDatabaseId,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastUsedAt: nowIso,
        status: "connected",
      };
      await this.repository.putConnection(connection);
      logInfo("notion.oauth.callback.connection_saved", {
        userHash: safeHash(stateRecord.userId),
        workspaceHash: safeHash(tokenData.workspace_name),
      });
    } finally {
      await this.repository.deleteOAuthState(input.state).catch((error) => {
        logWarn("notion.oauth_state.cleanup_failed", safeErrorDetails(error));
      });
    }

    return { redirectTo: stateRecord.redirectAfter || "/" };
  }

  async getConnectionForUse(
    userId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<{ connection: NotionConnectionRecord; accessToken: string }> {
    const config = getConfig().notion;
    const record = await this.repository.getConnection(userId);
    if (!record || record.status !== "connected") {
      throw new Error("Notion is not connected.");
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const needsRefresh = Boolean(
      options?.forceRefresh ||
      (record.expiresAt && record.expiresAt - nowEpoch <= 30),
    );
    if (!needsRefresh) {
      return {
        connection: record,
        accessToken: await decryptToken({
          ciphertext: record.accessTokenCiphertext,
          iv: record.accessTokenIv,
          authTag: record.accessTokenAuthTag,
        }),
      };
    }

    if (
      !record.refreshTokenCiphertext ||
      !record.refreshTokenIv ||
      !record.refreshTokenAuthTag
    ) {
      await this.repository.putConnection({
        ...record,
        status: "refresh_failed",
        updatedAt: new Date().toISOString(),
      });
      throw new Error(
        "Notion token refresh is required but refresh token is unavailable.",
      );
    }

    const decryptedRefreshToken = await decryptToken({
      ciphertext: record.refreshTokenCiphertext,
      iv: record.refreshTokenIv,
      authTag: record.refreshTokenAuthTag,
    });
    const connectionClientSecret = await decryptOptionalToken({
      ciphertext: record.oauthClientSecretCiphertext,
      iv: record.oauthClientSecretIv,
      authTag: record.oauthClientSecretAuthTag,
    });

    try {
      const refreshed = await refreshNotionToken({
        refreshToken: decryptedRefreshToken,
        clientId: record.oauthClientId ?? config.oauthClientId,
        clientSecret: connectionClientSecret ?? config.oauthClientSecret,
        tokenEndpoint: record.oauthTokenEndpoint,
        tokenEndpointAuthMethod: record.oauthTokenEndpointAuthMethod,
        resource: record.oauthResource,
      });
      const encryptedAccess = await encryptToken(refreshed.access_token);
      const encryptedRefresh = refreshed.refresh_token
        ? await encryptToken(refreshed.refresh_token)
        : undefined;
      const nowIso = new Date().toISOString();
      const updated: NotionConnectionRecord = {
        ...record,
        accessTokenCiphertext: encryptedAccess.ciphertext,
        accessTokenIv: encryptedAccess.iv,
        accessTokenAuthTag: encryptedAccess.authTag,
        refreshTokenCiphertext:
          encryptedRefresh?.ciphertext ?? record.refreshTokenCiphertext,
        refreshTokenIv: encryptedRefresh?.iv ?? record.refreshTokenIv,
        refreshTokenAuthTag:
          encryptedRefresh?.authTag ?? record.refreshTokenAuthTag,
        expiresAt: refreshed.expires_in
          ? Math.floor(Date.now() / 1000) + refreshed.expires_in
          : record.expiresAt,
        status: "connected",
        updatedAt: nowIso,
        lastUsedAt: nowIso,
      };
      await this.repository.putConnection(updated);
      return {
        connection: updated,
        accessToken: refreshed.access_token,
      };
    } catch (error) {
      await this.repository.putConnection({
        ...record,
        status: "refresh_failed",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }
}

function validateOauthConfiguration(): void {
  const config = getConfig().notion;
  if (!config.enabled) {
    throw new Error("Notion MCP integration is disabled.");
  }

  if (!config.redirectUri) {
    throw new Error("NOTION_REDIRECT_URI is required for Notion OAuth.");
  }
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  resource?: string;
}): Promise<NotionTokenResponse> {
  const config = getConfig().notion;
  const oauthMetadata = await discoverMcpOAuthMetadata(config.mcpUrl, {
    fallbackAuthorizationEndpoint: config.oauthAuthorizeUrl,
    fallbackTokenEndpoint: config.oauthTokenUrl,
  });
  const tokenEndpoint = input.tokenEndpoint || oauthMetadata.token_endpoint;
  const clientId = input.clientId || config.oauthClientId;
  if (!tokenEndpoint || !clientId) {
    throw new Error("OAuth token exchange prerequisites are missing.");
  }

  const method =
    input.tokenEndpointAuthMethod ??
    inferTokenEndpointAuthMethod({
      clientSecret: input.clientSecret ?? config.oauthClientSecret,
    });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (method === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${input.clientSecret ?? config.oauthClientSecret ?? ""}`).toString("base64")}`;
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: clientId,
    resource:
      input.resource ||
      oauthMetadata.resource ||
      deriveResourceFromMcpUrl(config.mcpUrl),
  });
  if (
    method === "client_secret_post" &&
    (input.clientSecret ?? config.oauthClientSecret)
  ) {
    body.set(
      "client_secret",
      input.clientSecret ?? config.oauthClientSecret ?? "",
    );
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    logWarn("notion.oauth.token_exchange.failed", {
      statusCode: response.status,
      responseBodyHash: safeHash(raw),
      responseBodyLength: raw.length,
    });
    throw new Error(
      `Notion OAuth token exchange failed with status ${response.status}. ${truncateForError(raw)}`,
    );
  }

  return (await response.json()) as NotionTokenResponse;
}

async function refreshNotionToken(input: {
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  resource?: string;
}): Promise<NotionTokenResponse> {
  const config = getConfig().notion;
  const oauthMetadata = await discoverMcpOAuthMetadata(config.mcpUrl, {
    fallbackAuthorizationEndpoint: config.oauthAuthorizeUrl,
    fallbackTokenEndpoint: config.oauthTokenUrl,
  });
  const tokenEndpoint = input.tokenEndpoint || oauthMetadata.token_endpoint;
  const clientId = input.clientId || config.oauthClientId;
  if (!tokenEndpoint || !clientId) {
    throw new Error("OAuth refresh prerequisites are missing.");
  }

  const method =
    input.tokenEndpointAuthMethod ??
    inferTokenEndpointAuthMethod({
      clientSecret: input.clientSecret ?? config.oauthClientSecret,
    });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (method === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${input.clientSecret ?? config.oauthClientSecret ?? ""}`).toString("base64")}`;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: clientId,
    resource:
      input.resource ||
      oauthMetadata.resource ||
      deriveResourceFromMcpUrl(config.mcpUrl),
  });
  if (
    method === "client_secret_post" &&
    (input.clientSecret ?? config.oauthClientSecret)
  ) {
    body.set(
      "client_secret",
      input.clientSecret ?? config.oauthClientSecret ?? "",
    );
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    logWarn("notion.oauth.refresh.failed", {
      statusCode: response.status,
      responseBodyHash: safeHash(raw),
      responseBodyLength: raw.length,
    });
    throw new Error(
      `Notion OAuth refresh failed with status ${response.status}. ${truncateForError(raw)}`,
    );
  }

  return (await response.json()) as NotionTokenResponse;
}

function createCodeVerifier(): string {
  return toBase64Url(randomBytes(64));
}

function createCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function resolveOAuthClientContext(input: {
  metadata: OAuthMetadata;
  redirectUri: string;
  staticClientId?: string;
  staticClientSecret?: string;
}): Promise<OAuthClientContext> {
  // Prefer Dynamic Client Registration to avoid Unknown OAuth client issues.
  if (input.metadata.registration_endpoint) {
    try {
      const registered = await registerDynamicClient({
        registrationEndpoint: input.metadata.registration_endpoint,
        redirectUri: input.redirectUri,
      });
      return {
        clientId: registered.clientId,
        clientSecret: registered.clientSecret,
        tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
        authorizationEndpoint: input.metadata.authorization_endpoint!,
        tokenEndpoint: input.metadata.token_endpoint!,
        resource: input.metadata.resource ?? "https://mcp.notion.com",
        clientSource: "dynamic_registration",
      };
    } catch (error) {
      logWarn(
        "notion.oauth.client_registration.failed",
        safeErrorDetails(error),
      );
    }
  }

  if (!input.staticClientId) {
    throw new Error(
      "Unable to register OAuth client and NOTION_OAUTH_CLIENT_ID is not configured.",
    );
  }

  return {
    clientId: input.staticClientId,
    clientSecret: input.staticClientSecret,
    tokenEndpointAuthMethod: inferTokenEndpointAuthMethod({
      clientSecret: input.staticClientSecret,
    }),
    authorizationEndpoint: input.metadata.authorization_endpoint!,
    tokenEndpoint: input.metadata.token_endpoint!,
    resource: input.metadata.resource ?? "https://mcp.notion.com",
    clientSource: "static_env",
  };
}

async function registerDynamicClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
}): Promise<{
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
}> {
  const response = await fetch(input.registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_name: "Tableau Chat Extension PoC",
      client_uri: "https://github.com/Chasoso/tableau-chat-extension",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OAuth dynamic client registration failed with status ${response.status}.`,
    );
  }

  const data = (await response.json()) as {
    client_id?: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
  };
  if (!data.client_id) {
    throw new Error("Dynamic client registration did not return client_id.");
  }

  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
    tokenEndpointAuthMethod: normalizeTokenEndpointAuthMethod(
      data.token_endpoint_auth_method,
    ),
  };
}

function inferTokenEndpointAuthMethod(input: {
  clientSecret?: string;
}): "none" | "client_secret_basic" | "client_secret_post" {
  return input.clientSecret ? "client_secret_basic" : "none";
}

function normalizeTokenEndpointAuthMethod(
  method?: string,
): "none" | "client_secret_basic" | "client_secret_post" {
  if (method === "client_secret_basic" || method === "client_secret_post") {
    return method;
  }
  return "none";
}

async function decryptOptionalToken(input: {
  ciphertext?: string;
  iv?: string;
  authTag?: string;
}): Promise<string | undefined> {
  if (!input.ciphertext || !input.iv || !input.authTag) {
    return undefined;
  }

  return decryptToken({
    ciphertext: input.ciphertext,
    iv: input.iv,
    authTag: input.authTag,
  });
}

function deriveResourceFromMcpUrl(mcpServerUrl: string): string {
  const url = new URL(mcpServerUrl);
  return `${url.protocol}//${url.host}`;
}

function truncateForError(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

async function discoverMcpOAuthMetadata(
  mcpServerUrl: string,
  fallback: {
    fallbackAuthorizationEndpoint: string;
    fallbackTokenEndpoint: string;
  },
): Promise<OAuthMetadata> {
  if (
    cachedMcpOAuthMetadata?.authorization_endpoint &&
    cachedMcpOAuthMetadata?.token_endpoint
  ) {
    return cachedMcpOAuthMetadata;
  }

  try {
    const protectedResourceUrl = new URL(
      "/.well-known/oauth-protected-resource",
      mcpServerUrl,
    );
    const protectedResourceResponse = await fetch(
      protectedResourceUrl.toString(),
    );
    if (!protectedResourceResponse.ok) {
      throw new Error(
        `protected-resource-metadata status ${protectedResourceResponse.status}`,
      );
    }

    const protectedResource = (await protectedResourceResponse.json()) as {
      authorization_servers?: string[];
      resource?: string;
    };
    const authServer = Array.isArray(protectedResource.authorization_servers)
      ? protectedResource.authorization_servers[0]
      : undefined;
    if (!authServer) {
      throw new Error("authorization_servers is missing");
    }

    const oauthMetadataUrl = new URL(
      "/.well-known/oauth-authorization-server",
      authServer,
    );
    const oauthMetadataResponse = await fetch(oauthMetadataUrl.toString());
    if (!oauthMetadataResponse.ok) {
      throw new Error(
        `oauth-authorization-server status ${oauthMetadataResponse.status}`,
      );
    }

    const metadata = (await oauthMetadataResponse.json()) as OAuthMetadata;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error("authorization_endpoint or token_endpoint is missing");
    }
    metadata.resource =
      protectedResource.resource || deriveResourceFromMcpUrl(mcpServerUrl);

    cachedMcpOAuthMetadata = metadata;
    logInfo("notion.oauth.discovery.completed", {
      hasIssuer: Boolean(metadata.issuer),
      authorizationEndpointHostHash: safeHash(
        new URL(metadata.authorization_endpoint).host,
      ),
      tokenEndpointHostHash: safeHash(new URL(metadata.token_endpoint).host),
      mcpUrlHostHash: safeHash(new URL(mcpServerUrl).host),
    });
    return metadata;
  } catch (error) {
    logWarn("notion.oauth.discovery.fallback", {
      ...safeErrorDetails(error),
      mcpUrlHostHash: safeHash(new URL(mcpServerUrl).host),
    });
    const fallbackMetadata: OAuthMetadata = {
      authorization_endpoint: fallback.fallbackAuthorizationEndpoint,
      token_endpoint: fallback.fallbackTokenEndpoint,
      resource: deriveResourceFromMcpUrl(mcpServerUrl),
    };
    cachedMcpOAuthMetadata = fallbackMetadata;
    return fallbackMetadata;
  }
}
