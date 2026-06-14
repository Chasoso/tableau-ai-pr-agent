import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails, safeHash } from "../logging";
import { GoogleCalendarOAuthService } from "../services/googleCalendarOAuthService";
import type { AuthenticatedUser } from "../types/auth";
import type { ApiGatewayProxyEvent, ApiGatewayProxyResult } from "../types/api";
import type { GoogleCalendarPopupStartRequest } from "../types/googleCalendarAuth";

const service = new GoogleCalendarOAuthService();

export async function handleGoogleCalendarAuthRoute(
  event: ApiGatewayProxyEvent,
  user: AuthenticatedUser | undefined,
): Promise<ApiGatewayProxyResult> {
  const method =
    event.httpMethod ?? event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.path ?? "";

  try {
    if (path === "/auth/google/popup/start" && method === "POST") {
      const payload = parseStartRequest(event.body);
      logInfo("google.oauth.start.requested", {
        hasRedirectAfter: Boolean(payload.redirectAfter),
        userHash: safeHash(user?.userId),
      });
      return jsonResponse(200, await service.startPopupAuth(user, payload));
    }

    if (path === "/auth/google/callback" && method === "GET") {
      const code = event.queryStringParameters?.code;
      const state = event.queryStringParameters?.state;
      logInfo("google.oauth.callback.received", {
        hasCode: Boolean(code),
        hasState: Boolean(state),
        stateHash: safeHash(state),
      });
      try {
        const result = await service.handlePopupCallback({ code, state });
        logInfo("google.oauth.callback.completed", {
          ok: true,
          redirectAfterHash: safeHash(result.redirectAfter),
        });
        return htmlResponse(
          200,
          renderPopupCallbackHtml({
            success: true,
          }),
        );
      } catch (error) {
        const userFacing = toUserFacingMessage(error);
        logWarn("google.oauth.callback.failed", {
          hasCode: Boolean(code),
          hasState: Boolean(state),
          stateHash: safeHash(state),
          statusCode: userFacing.statusCode,
          ...safeErrorDetails(error),
        });
        return htmlResponse(
          userFacing.statusCode,
          renderPopupCallbackHtml({
            success: false,
            message: userFacing.text,
          }),
        );
      }
    }

    if (path === "/auth/google/popup/status" && method === "GET") {
      const transactionId = event.queryStringParameters?.transactionId ?? "";
      const pollToken = getHeader(event.headers, "x-auth-poll-token");
      const response = await service.getPopupAuthStatus({
        transactionId,
        pollToken,
      });
      return jsonResponse(response.status === "failed" ? 400 : 200, response);
    }

    if (path === "/auth/google/status" && method === "GET") {
      return jsonResponse(200, await service.getStatus(user));
    }

    if (path === "/auth/google/disconnect" && method === "POST") {
      await service.disconnect(user);
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { message: "Google auth route not found." });
  } catch (error) {
    if (path === "/auth/google/callback") {
      logWarn("google.oauth.callback.route_failed", safeErrorDetails(error));
      return htmlResponse(
        500,
        renderPopupCallbackHtml({
          success: false,
          message:
            "Google 接続の完了に失敗しました。このウィンドウを閉じて、もう一度お試しください。",
        }),
      );
    }

    logWarn("google.oauth.route_failed", {
      path,
      method,
      ...safeErrorDetails(error),
    });
    return jsonResponse(500, {
      message:
        error instanceof Error ? error.message : "Google OAuth request failed.",
    });
  }
}

function parseStartRequest(
  body: string | null | undefined,
): GoogleCalendarPopupStartRequest {
  if (!body) {
    return {};
  }

  const parsed = JSON.parse(body) as GoogleCalendarPopupStartRequest;
  return {
    redirectAfter: parsed.redirectAfter,
  };
}

function jsonResponse(
  statusCode: number,
  payload: unknown,
): ApiGatewayProxyResult {
  const config = getConfig();
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": config.corsAllowedOrigin,
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Auth-Poll-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function htmlResponse(statusCode: number, html: string): ApiGatewayProxyResult {
  const config = getConfig();
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": config.corsAllowedOrigin,
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Auth-Poll-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
    body: html,
  };
}

function renderPopupCallbackHtml(input: {
  success: boolean;
  message?: string;
}): string {
  const message = input.message
    ? escapeHtml(input.message)
    : input.success
      ? "Google 接続が完了しました。このウィンドウはまもなく閉じます。"
      : "Google 接続に失敗しました。このウィンドウを閉じて、もう一度お試しください。";

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PR投稿エージェント</title>
    <style>
      body { font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #f6f7f9; color: #1f2937; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; padding:16px; box-sizing:border-box; }
      .card { background:#fff; border:1px solid #d5d9e0; border-radius:14px; padding:20px 22px; width:min(380px, 92vw); box-shadow:0 14px 32px rgba(15, 23, 42, 0.12); text-align:center; }
      h1 { margin:0 0 10px; font-size:18px; font-weight:700; line-height:1.4; color:#0f172a; }
      p { margin:0; font-size:14px; line-height:1.7; color:#334155; }
      .helper { margin-top:10px; font-size:12px; color:#6b7280; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>PR投稿エージェント</h1>
      <p>${message}</p>
      <p class="helper">閉じない場合は、このウィンドウを手動で閉じて元の画面に戻ってください。</p>
    </section>
    <script>
      window.setTimeout(function () {
        window.close();
      }, 1200);
    </script>
  </body>
</html>`;
}

function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toUserFacingMessage(error: unknown): {
  statusCode: number;
  text: string;
} {
  const message =
    error instanceof Error ? error.message : "Google integration failed.";
  if (/state expired|state not found|OAuth state/i.test(message)) {
    return {
      statusCode: 400,
      text: "Google authorization session expired. Please connect again.",
    };
  }
  if (/required|missing/i.test(message)) {
    return { statusCode: 400, text: message };
  }
  if (/refresh token|token exchange/i.test(message)) {
    return {
      statusCode: 401,
      text: "Google 接続に失敗しました。認可をやり直してください。",
    };
  }

  return { statusCode: 500, text: "Google request failed. Please retry." };
}
