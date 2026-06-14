import { env } from "../env";
import type { AuthSession } from "../types/auth";

const sessionKey = "tableau-ai-pr-agent.auth.session";
const legacySessionKey = "tableau-chat.auth.session";
const verifierKeyPrefix = "tableau-ai-pr-agent.auth.pkce.verifier.";
const legacyVerifierKeyPrefix = "tableau-chat.auth.pkce.verifier.";

export { sessionKey };

export function getStoredSession(): AuthSession | null {
  const raw =
    localStorage.getItem(sessionKey) || localStorage.getItem(legacySessionKey);
  if (!raw) {
    return null;
  }

  const session = JSON.parse(raw) as AuthSession;
  if (session.expiresAt <= Date.now() + 30_000) {
    clearSession();
    return null;
  }

  return session;
}

export async function completeLoginFromRedirect(): Promise<AuthSession | null> {
  const session = await completeLoginFromUrl(window.location.href);
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("auth_action");
  window.history.replaceState({}, document.title, url.toString());
  return session;
}

export async function completeLoginFromUrl(
  urlValue: string,
): Promise<AuthSession | null> {
  const url = new URL(urlValue);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) {
    return getStoredSession();
  }

  if (!state) {
    throw new Error(
      "サインイン状態を確認できませんでした。もう一度サインインしてください。",
    );
  }

  const verifier =
    localStorage.getItem(getVerifierKey(state)) ||
    localStorage.getItem(getLegacyVerifierKey(state));
  if (!verifier) {
    throw new Error(
      "サインインセッションの情報が見つかりませんでした。もう一度サインインしてください。",
    );
  }

  const tokenResponse = await fetch(`${getCognitoDomain()}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.cognito.clientId,
      code,
      redirect_uri: getRedirectUri(),
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error("Cognito サインインに失敗しました。");
  }

  const body = (await tokenResponse.json()) as {
    access_token: string;
    id_token: string;
    expires_in: number;
  };

  const session: AuthSession = {
    accessToken: body.access_token,
    idToken: body.id_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    ...decodeClaims(body.id_token),
  };

  storeSession(session);
  localStorage.removeItem(getVerifierKey(state));
  localStorage.removeItem(getLegacyVerifierKey(state));
  return session;
}

export async function startLogin(): Promise<void> {
  const loginUrl = await createLoginUrl();
  window.location.assign(loginUrl);
}

export function openLoginPopupWindow(): Window {
  const popup = window.open(
    "",
    "tableau-ai-pr-agent-cognito-login",
    "popup,width=520,height=720",
  );
  if (!popup) {
    throw new Error(
      "サインインウィンドウを開けませんでした。このサイトのポップアップを許可してください。",
    );
  }

  popup.focus();
  try {
    popup.document.write(`
      <!doctype html>
      <html lang="ja">
        <head>
          <meta charset="utf-8" />
          <title>PR投稿エージェント</title>
          <style>
            body { font-family: sans-serif; background:#f6f7f9; color:#1f2937; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
            .card { background:#fff; border:1px solid #d5d9e0; border-radius:16px; padding:24px; width:min(420px, 92vw); text-align:center; box-shadow:0 16px 36px rgba(15,23,42,.12); }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>PR投稿エージェント</h1>
            <p>サインイン画面を準備しています…</p>
          </div>
        </body>
      </html>
    `);
    popup.document.close();
  } catch {
    // Ignore cross-browser popup document initialization issues.
  }
  return popup;
}

export function isAuthRedirect(): boolean {
  return new URL(window.location.href).searchParams.has("code");
}

export function isAuthPopupStart(): boolean {
  return (
    new URL(window.location.href).searchParams.get("auth_action") ===
    "login_popup"
  );
}

export function storeSession(session: AuthSession): void {
  localStorage.setItem(sessionKey, JSON.stringify(session));
  localStorage.setItem(legacySessionKey, JSON.stringify(session));
}

export function signOut(): void {
  clearSession();

  if (!env.cognito.domain || !env.cognito.clientId) {
    return;
  }

  const logoutUrl = new URL(`${getCognitoDomain()}/logout`);
  logoutUrl.searchParams.set("client_id", env.cognito.clientId);
  logoutUrl.searchParams.set("logout_uri", getLogoutUri());
  window.location.assign(logoutUrl.toString());
}

export function assertAuthConfigured(): void {
  if (!env.cognito.clientId || !env.cognito.domain) {
    throw new Error("Cognito Hosted UI が設定されていません。");
  }
}

async function createLoginUrl(): Promise<string> {
  assertAuthConfigured();
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  const challenge = await sha256Base64Url(verifier);
  localStorage.setItem(getVerifierKey(state), verifier);

  const authUrl = new URL(`${getCognitoDomain()}/oauth2/authorize`);
  authUrl.searchParams.set("client_id", env.cognito.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email");
  authUrl.searchParams.set("redirect_uri", getRedirectUri());
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);
  return authUrl.toString();
}

function clearSession(): void {
  localStorage.removeItem(sessionKey);
  localStorage.removeItem(legacySessionKey);
  for (const key of Object.keys(localStorage)) {
    if (
      key.startsWith(verifierKeyPrefix) ||
      key.startsWith(legacyVerifierKeyPrefix)
    ) {
      localStorage.removeItem(key);
    }
  }
}

function getCognitoDomain(): string {
  return env.cognito.domain.replace(/\/$/, "");
}

function getRedirectUri(): string {
  if (env.cognito.redirectUri) {
    return env.cognito.redirectUri;
  }

  return `${window.location.origin}${window.location.pathname}`;
}

function getLogoutUri(): string {
  return env.cognito.logoutUri || getRedirectUri();
}

function getVerifierKey(state: string): string {
  return `${verifierKeyPrefix}${state}`;
}

function getLegacyVerifierKey(state: string): string {
  return `${legacyVerifierKeyPrefix}${state}`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeClaims(token: string): Pick<AuthSession, "email" | "nickname"> {
  const [, payload] = token.split(".");
  if (!payload) {
    return {};
  }

  try {
    const normalized = addBase64Padding(
      payload.replaceAll("-", "+").replaceAll("_", "/"),
    );
    const decoded = JSON.parse(atob(normalized)) as {
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
